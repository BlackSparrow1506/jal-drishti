import { Alert, Platform } from 'react-native';

// Alert.alert with buttons does nothing in a browser, so web uses the built-in dialogs.
export function confirm({ title, message, okText, cancelText, destructive, onConfirm }) {
  if (Platform.OS === 'web') {
    if (window.confirm(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: cancelText, style: 'cancel' },
    { text: okText, style: destructive ? 'destructive' : 'default', onPress: onConfirm },
  ]);
}

export function notify(title, message) {
  if (Platform.OS === 'web') window.alert(`${title}\n\n${message}`);
  else Alert.alert(title, message);
}
