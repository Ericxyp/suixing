import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { parseHomeTripRequest } from '../../services/plan-conversation-service';

export function CreateTripEntry() {
  const [request, setRequest] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const navigate = useNavigate();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseHomeTripRequest(request);
    if (!parsed.ok) {
      setNotice(parsed.notice);
      return;
    }
    setNotice(null);
    navigate(parsed.path, { state: parsed.state });
  }

  return (
    <section className="create-entry" aria-labelledby="create-trip-title">
      <p className="eyebrow">开始规划</p>
      <h1 id="create-trip-title">下一站，想去哪？</h1>
      <p className="section-description">说说目的地、日期、同行人和你想怎样玩。</p>
      <form className="trip-form" onSubmit={submit}>
        <label className="sr-only" htmlFor="trip-request">旅行需求</label>
        <input
          id="trip-request"
          value={request}
          onChange={(event) => setRequest(event.target.value)}
          placeholder="例如：国庆去上海 3 天，想慢慢逛"
        />
        <button type="submit">开始规划</button>
      </form>
      {notice && <p className="form-notice" aria-live="polite">{notice}</p>}
    </section>
  );
}
