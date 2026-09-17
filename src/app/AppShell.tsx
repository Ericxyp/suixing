import { Link, Outlet } from 'react-router-dom';

export function AppShell() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <Link className="brand" to="/">随行</Link>
      </header>
      <main className="app-content">
        <Outlet />
      </main>
    </div>
  );
}
