"""2D flood-wave routing on the real terrain: local-inertial shallow-water scheme.

This is the formulation used by LISFLOOD-FP (Bates, Horritt & Fewtrell 2010; de Almeida et al.
2012): the momentum equation keeps the local acceleration and drops convective terms, which is
accurate for floodplain inundation and dam-break waves once they leave the near field. Fluxes
live on cell faces, depths on cell centres, friction is semi-implicit Manning, and the time step
follows the CFL limit. Water enters at the breach cells from the reservoir outflow hydrograph
and leaves through the domain edges.

Near-field (the first few hundred metres, where the flow is violently 3D) is where the SPH model
in the pitch applies. This solver covers the far-field routing that Delft3D-FM would do.
"""
import math
import time

import numpy as np

G = 9.81
DRY = 0.01      # m, depth below which a cell counts as dry
WET = 0.10      # m, depth used for "flooded" statistics and arrival time
N_BY_LANDCOVER = {   # ESA WorldCover class -> Manning n (Chow 1959; Arcement & Schneider 1989)
    10: 0.10, 20: 0.07, 30: 0.035, 40: 0.04, 50: 0.12, 60: 0.03,
    70: 0.02, 80: 0.03, 90: 0.05, 95: 0.12, 100: 0.035,
}


def depth_code(h):
    """Depth (m) -> uint8. sqrt scale: 0.1 m steps near zero, ~40 m at 255."""
    return np.clip(np.round(40.0 * np.sqrt(np.maximum(h, 0))), 0, 255).astype(np.uint8)


def depth_from_code(c):
    return (np.asarray(c, float) / 40.0) ** 2


def simulate(z, n_manning, cell, inflow, dt_in, sources, duration_s, snap_s=300.0,
             progress=None, max_steps=400_000, max_level=None):
    """Run the flood model.

    z           bed elevation (ny, nx), metres
    n_manning   Manning n per cell (ny, nx)
    inflow      discharge series (m3/s) sampled every dt_in seconds from the model start
    sources     list of (j, i) cells that receive the inflow, shared equally
    max_level   water can't rise above the reservoir pool at the breach: inflow that would lift the
                source cells higher waits (it is still counted, and enters once there is room)
    Returns dict with frames (uint8 depth codes), times, max depth, max speed, arrival (min).
    """
    ny, nx = z.shape
    z = z.astype(np.float64)
    h = np.zeros((ny, nx))
    qx = np.zeros((ny, nx + 1))    # face between (j, i-1) and (j, i); edges stay 0
    qy = np.zeros((ny + 1, nx))
    n2 = n_manning.astype(np.float64) ** 2
    n2x = 0.5 * (n2[:, 1:] + n2[:, :-1])
    n2y = 0.5 * (n2[1:, :] + n2[:-1, :])
    area = cell * cell
    src_j = np.array([s[0] for s in sources])
    src_i = np.array([s[1] for s in sources])

    edge = np.zeros((ny, nx), bool)
    edge[0, :] = edge[-1, :] = edge[:, 0] = edge[:, -1] = True

    hmax = np.zeros((ny, nx))
    vmax = np.zeros((ny, nx))
    arrival = np.full((ny, nx), -1.0)
    frames, times = [], []
    t, next_snap, steps = 0.0, 0.0, 0
    volume_in = volume_out = backlog = 0.0
    wall = time.time()

    def q_at(tt):
        k = tt / dt_in
        i0 = int(k)
        if i0 >= len(inflow) - 1:
            return float(inflow[-1]) if len(inflow) else 0.0
        return float(inflow[i0] + (inflow[i0 + 1] - inflow[i0]) * (k - i0))

    while t < duration_s and steps < max_steps:
        hm = h.max()
        dt = min(30.0, 0.7 * cell / math.sqrt(G * max(hm, 0.05)), duration_s - t + 1e-6)

        eta = z + h
        # x faces (interior)
        hf = np.maximum(eta[:, 1:], eta[:, :-1]) - np.maximum(z[:, 1:], z[:, :-1])
        wetf = hf > 1e-3
        hf = np.where(wetf, hf, 1.0)
        s = (eta[:, 1:] - eta[:, :-1]) / cell
        q = qx[:, 1:-1]
        q = (q - G * hf * dt * s) / (1 + G * dt * n2x * np.abs(q) / hf ** (7 / 3))
        lim = hf * np.sqrt(G * hf)                     # Froude <= 1 limiter for stability
        qx[:, 1:-1] = np.where(wetf, np.clip(q, -lim, lim), 0.0)
        # y faces (interior)
        hf = np.maximum(eta[1:, :], eta[:-1, :]) - np.maximum(z[1:, :], z[:-1, :])
        wetf = hf > 1e-3
        hf = np.where(wetf, hf, 1.0)
        s = (eta[1:, :] - eta[:-1, :]) / cell
        q = qy[1:-1, :]
        q = (q - G * hf * dt * s) / (1 + G * dt * n2y * np.abs(q) / hf ** (7 / 3))
        lim = hf * np.sqrt(G * hf)
        qy[1:-1, :] = np.where(wetf, np.clip(q, -lim, lim), 0.0)

        # Continuity. Scale outgoing fluxes where they would drain a cell below zero.
        dh = (qx[:, :-1] - qx[:, 1:] + qy[:-1, :] - qy[1:, :]) * dt / cell
        neg = h + dh < 0
        if neg.any():
            out = (np.maximum(qx[:, 1:], 0) + np.maximum(-qx[:, :-1], 0) +
                   np.maximum(qy[1:, :], 0) + np.maximum(-qy[:-1, :], 0)) * dt / cell
            f = np.where(neg & (out > 0), np.minimum(1.0, h / np.maximum(out, 1e-12)), 1.0)
            qx[:, 1:] = np.where(qx[:, 1:] > 0, qx[:, 1:] * f, qx[:, 1:])
            qx[:, :-1] = np.where(qx[:, :-1] < 0, qx[:, :-1] * f, qx[:, :-1])
            qy[1:, :] = np.where(qy[1:, :] > 0, qy[1:, :] * f, qy[1:, :])
            qy[:-1, :] = np.where(qy[:-1, :] < 0, qy[:-1, :] * f, qy[:-1, :])
            dh = (qx[:, :-1] - qx[:, 1:] + qy[:-1, :] - qy[1:, :]) * dt / cell
        h = np.maximum(h + dh, 0.0)

        vol = q_at(t) * dt + backlog
        if vol > 0:
            add = np.full(len(sources), vol / len(sources)) / area
            if max_level is not None:
                room = np.maximum(0.0, max_level - (z[src_j, src_i] + h[src_j, src_i]))
                add = np.minimum(add, room)
            h[src_j, src_i] += add
            used = float(add.sum() * area)
            backlog = vol - used
            volume_in += used
        volume_out += h[edge].sum() * area
        h[edge] = 0.0                                   # open boundary: water leaves the domain

        t += dt
        steps += 1
        wet = h > WET
        newly = wet & (arrival < 0)
        arrival[newly] = t / 60.0
        np.maximum(hmax, h, out=hmax)
        if steps % 5 == 0:
            ux = 0.5 * (qx[:, 1:] + qx[:, :-1])
            uy = 0.5 * (qy[1:, :] + qy[:-1, :])
            # Speeds in nearly dry cells are numerical noise; cap at a physical 25 m/s.
            speed = np.where(h > 0.3, np.minimum(25.0, np.hypot(ux, uy) / np.maximum(h, 0.3)), 0.0)
            np.maximum(vmax, speed, out=vmax)
        if t >= next_snap:
            frames.append(depth_code(np.where(h > DRY, h, 0)))
            times.append(round(t / 60.0, 1))
            next_snap += snap_s
            if progress:
                progress(min(0.999, t / duration_s))

    return {
        "frames": frames,
        "times_min": times,
        "hmax": hmax,
        "vmax": vmax,
        "arrival_min": arrival,
        "steps": steps,
        "volume_in_mm3": round(volume_in / 1e6, 3),
        "volume_out_mm3": round(volume_out / 1e6, 3),
        "volume_left_mm3": round(float(h.sum() * area / 1e6), 3),
        "volume_waiting_mm3": round(backlog / 1e6, 3),
        "wall_s": round(time.time() - wall, 1),
    }


def hazard_class(hmax, vmax):
    """Flood hazard by depth x velocity (UK EA / DEFRA FD2320 style, simplified).

    0 dry, 1 low (caution), 2 moderate (danger for some), 3 significant (danger for most),
    4 extreme (danger for all, including emergency services).
    """
    dv = hmax * (vmax + 0.5)
    cls = np.zeros(hmax.shape, np.uint8)
    wet = hmax > WET
    cls[wet] = 1
    cls[wet & ((dv > 0.75) | (hmax > 0.5))] = 2
    cls[wet & ((dv > 1.25) | (hmax > 1.5))] = 3
    cls[wet & ((dv > 2.5) | (hmax > 3.0))] = 4
    return cls
