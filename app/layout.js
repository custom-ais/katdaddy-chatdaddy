import './globals.css';

export const metadata = {
  title: 'Book with BOB | Dryer Vent Squad West Valley',
  description: 'See your price and book a dryer vent cleaning or repair with Dryer Vent Squad West Valley.',
  icons: { icon: '/bob-avatar.svg' },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#083653',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600&family=Montserrat:wght@400;500;600;700;800&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
