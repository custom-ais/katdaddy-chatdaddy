import BobChat from '@/components/bob/BobChat';

export const metadata = { title: 'BOB booking chat' };

export default function Embed() {
  return (
    <main className="embed">
      <BobChat mode="embed" />
    </main>
  );
}
