import { getAddress } from 'viem';
import { isChainKey } from './config.js';
import { AgentScreen, isAgentRoute } from './screens/Agent.js';
import { HomeScreen } from './screens/Home.js';
import { RequestScreen } from './screens/Request.js';
import { SetupScreen } from './screens/Setup.js';
import { ServerProvider, useHashRoute } from './ui.js';

function Routes() {
  const [screen, a, b] = useHashRoute();
  if (screen === 'r' && a) return <RequestScreen key={a} id={a} />;
  if (screen === 'a' && isAgentRoute(a, b) && isChainKey(a)) {
    const agent = getAddress(b!);
    return <AgentScreen key={a + agent} chain={a} agent={agent} />;
  }
  if (screen === 'setup') return <SetupScreen />;
  return <HomeScreen />;
}

export function App() {
  return (
    <ServerProvider>
      <Routes />
    </ServerProvider>
  );
}
