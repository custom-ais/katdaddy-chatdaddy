import './globals.css';

export const metadata = {
  title: 'ChatDaddy',
  description: 'Dryer Vent Squad booking and Jobber connector',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
