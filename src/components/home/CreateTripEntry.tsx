import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  applyInspirationChip,
  HOME_INSPIRATION_CHIPS,
} from '../../services/home-presentation';
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
    <section className="home-hero" aria-labelledby="create-trip-title">
      <div className="home-hero__copy">
        <p className="home-hero__eyebrow">Travel with Suixing</p>
        <h1 id="create-trip-title">下一站，想去哪？</h1>
        <p className="section-description">说说目的地、日期、同行人和你想怎样玩。</p>
      </div>
      <div className="home-hero__collage" aria-hidden="true">
        <span className="home-hero__sheet home-hero__sheet--a" />
        <span className="home-hero__sheet home-hero__sheet--b" />
        <span className="home-hero__sheet home-hero__sheet--c" />
        <span className="home-hero__stamp" />
        <span className="home-hero__arc" />
      </div>
      <form className="trip-form home-hero__form" onSubmit={submit}>
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
      <ul className="home-chips" aria-label="旅行灵感">
        {HOME_INSPIRATION_CHIPS.map((chip, index) => (
          <li key={chip}>
            <button
              className={`home-chip home-chip--${index}`}
              type="button"
              onClick={() => {
                setRequest((current) => applyInspirationChip(current, chip));
                setNotice(null);
              }}
            >
              {chip}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
