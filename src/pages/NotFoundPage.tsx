import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <section className="entry-page">
      <p className="eyebrow">404</p>
      <h1>这个页面不在行程中</h1>
      <p>请返回首页，继续规划你的下一站。</p>
      <Link className="text-link" to="/">返回首页</Link>
    </section>
  );
}
