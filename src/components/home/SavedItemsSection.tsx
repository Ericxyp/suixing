import type { SavedItem, SavedItemType } from '../../domain/saved-items/types';

const typeLabels: Record<SavedItemType, string> = {
  place: '地点',
  destination: '目的地灵感',
  route: '路线片段',
};

export function SavedItemsSection({ items }: { items: SavedItem[] }) {
  return (
    <section className="home-section" aria-labelledby="saved-items-title">
      <div className="section-heading">
        <h2 id="saved-items-title">收藏的地点与灵感</h2>
      </div>
      {items.length === 0 ? (
        <p className="state-message">还没有收藏。看到想去的地方，就先留在这里。</p>
      ) : (
        <div className="saved-list">
          {items.map((item) => (
            <article className="saved-card" key={item.id}>
              <p className="saved-card__type">{typeLabels[item.type]}</p>
              <h3>{item.title}</h3>
              <p>{item.subtitle ?? item.destination ?? '国内旅行灵感'}</p>
              {item.tags && <p className="saved-card__tags">{item.tags.join(' · ')}</p>}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
