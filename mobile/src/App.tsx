import { useEffect } from 'react';
import { useAppStore } from './store/useAppStore';
import { ConnectScreen } from './screens/ConnectScreen';
import { LoginScreen } from './screens/LoginScreen';
import { ChatScreen } from './screens/ChatScreen';
import { AccountScreen } from './screens/AccountScreen';
import { Loader2 } from 'lucide-react';

export function App() {
  const hydrated = useAppStore((s) => s.hydrated);
  const route = useAppStore((s) => s.route);
  const hydrate = useAppStore((s) => s.hydrate);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  if (!hydrated) {
    return (
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--fg-faint)' }}>
        <Loader2 size={28} className="spin" />
      </div>
    );
  }

  switch (route) {
    case 'connect':
      return <ConnectScreen />;
    case 'login':
      return <LoginScreen />;
    case 'account':
      return <AccountScreen />;
    case 'chat':
    default:
      return <ChatScreen />;
  }
}
