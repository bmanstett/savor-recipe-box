import { requireChatGPTUser } from './chatgpt-auth';
import { SavorApp } from './components/SavorApp';
import { getBootstrapData } from '../lib/server/database';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const user = await requireChatGPTUser('/');
  const initialData = await getBootstrapData({ displayName: user.displayName, email: user.email });
  return <SavorApp initialData={initialData} />;
}
