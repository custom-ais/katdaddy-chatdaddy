export default function Home() {
  return (
    <main>
      <h1>ChatDaddy</h1>
      <p className="sub">Dryer Vent Squad booking and Jobber connector</p>

      <div className="card">
        <h2>Status</h2>
        <p style={{ margin: 0 }}>
          The app is live. Connect Jobber and check your settings on the admin page.
        </p>
        <p style={{ marginBottom: 0 }}>
          <a className="btn" href="/admin">
            Open admin
          </a>
        </p>
      </div>
    </main>
  );
}
