import BobChat from '@/components/bob/BobChat';
import { BUSINESS, HOURS_TEXT } from '@/lib/bob/catalog';

export default function Home() {
  return (
    <div className="home">
      <header className="home-bar">
        <a href={BUSINESS.website} className="home-logo">
          <img src={BUSINESS.logo} alt="Dryer Vent Squad West Valley" height="44" />
        </a>
        <a className="home-call" href={`tel:${BUSINESS.tel}`}>
          Call {BUSINESS.phone}
        </a>
      </header>

      <main className="home-main">
        <section className="home-intro">
          <h1>Book your dryer vent service in about two minutes.</h1>
          <p className="home-lede">
            BOB asks a few questions about your dryer, shows your exact price, and books a time that&apos;s open on our schedule.
          </p>
          <ul className="home-points">
            <li>Your price is shown before you book</li>
            <li>Live camera inspection on every cleaning</li>
            <li>Veteran-owned and local to the West Valley</li>
          </ul>
          <p className="home-hours">
            Appointments {HOURS_TEXT}. Rather talk to a person? <a href={`tel:${BUSINESS.tel}`}>{BUSINESS.phone}</a>
          </p>
        </section>

        <div className="home-chat">
          <BobChat mode="page" />
        </div>
      </main>

      <footer className="home-foot">
        <span>{BUSINESS.name}</span>
        <span className="home-powered">
          <img src="/chatdaddy-mark.webp" alt="" width="22" height="22" />
          Powered by ChatDaddy
          <a href="/admin">Team login</a>
        </span>
      </footer>
    </div>
  );
}
