import { useEffect, useRef } from 'react';
import type { Place, TripScheduleItem } from '../../domain/trip/types';
import {
  MEAL_OPTIONS_EMPTY_COPY,
  MEAL_OPTIONS_EMPTY_TITLE,
  mealOptionRouteCopy,
  mealOptionsContext,
  mealOptionsHeading,
  mealOptionTypeLabel,
} from '../../services/meal-options-display';
import { lockBackgroundScroll } from '../../services/mobile-viewport';
import { visibleUserText } from '../../services/trip-display';

export function MealOptionsSheet({
  slot,
  areaName,
  options,
  status,
  category,
  nextName,
  applyingPlaceId,
  applyError,
  onClose,
  onRetry,
  onFilter,
  onSelect,
}: {
  slot: Extract<TripScheduleItem, { kind: 'meal_slot' }>;
  areaName: string;
  options: Place[];
  status: 'loading' | 'ready' | 'empty' | 'error';
  category: 'nearby' | 'coffee';
  nextName?: string;
  applyingPlaceId?: string | null;
  applyError?: string | null;
  onClose: () => void;
  onRetry: () => void;
  onFilter: (category: 'nearby' | 'coffee') => void;
  onSelect: (placeId: string) => void;
}) {
  const title = mealOptionsHeading(slot, areaName);
  const context = mealOptionsContext(slot, areaName, nextName);
  const busy = Boolean(applyingPlaceId);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy) {
        onClose();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  useEffect(() => {
    const lock = lockBackgroundScroll();
    window.requestAnimationFrame(() => closeRef.current?.focus());
    return () => lock.unlock();
  }, []);

  return (
    <div className="meal-options-layer">
      <button
        className="meal-options-dismiss"
        type="button"
        aria-label="关闭用餐安排"
        disabled={busy}
        onClick={onClose}
      />
      <aside
        className="meal-options-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="meal-options-title"
      >
        <header className="meal-options-sheet__header">
          <div>
            <p className="meal-options-sheet__eyebrow">用餐安排</p>
            <h2 id="meal-options-title">{title}</h2>
            <p className="meal-options-sheet__context">{context}</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="关闭用餐安排"
            disabled={busy}
            onClick={onClose}
          >
            关闭
          </button>
        </header>
        <div className="meal-options-filters" role="tablist" aria-label="用餐类型">
          <button type="button" aria-pressed={category === 'nearby'} disabled={busy} onClick={() => onFilter('nearby')}>
            附近餐饮
          </button>
          <button type="button" aria-pressed={category === 'coffee'} disabled={busy} onClick={() => onFilter('coffee')}>
            咖啡休息
          </button>
        </div>
        <div className="meal-options-sheet__body">
          {status === 'loading' && (
            <div className="meal-option-skeletons" role="status" aria-label="正在查找附近餐饮">
              <div className="meal-option-skeleton" />
              <div className="meal-option-skeleton" />
              <div className="meal-option-skeleton" />
              <div className="meal-option-skeleton" />
            </div>
          )}
          {status === 'error' && (
            <div className="meal-options-sheet__empty" role="status">
              <h3>暂时无法加载餐饮地点</h3>
              <p>请稍后重试，当前行程不会被改动。</p>
              <button type="button" onClick={onRetry}>重试</button>
            </div>
          )}
          {status === 'empty' && (
            <div className="meal-options-sheet__empty" role="status">
              <h3>{MEAL_OPTIONS_EMPTY_TITLE}</h3>
              <p>{MEAL_OPTIONS_EMPTY_COPY}</p>
              <button type="button" onClick={onRetry}>重试</button>
            </div>
          )}
          {status === 'ready' && options.map((place) => {
            const applying = applyingPlaceId === place.id;
            const name = visibleUserText(place.name) ?? '餐饮地点';
            return (
              <article className="meal-option" key={place.id}>
                <div>
                  <h3>{name}</h3>
                  <p>{mealOptionTypeLabel(place.category)}</p>
                  <p>{mealOptionRouteCopy(place, nextName)}</p>
                </div>
                <button
                  type="button"
                  disabled={applying}
                  onClick={() => onSelect(place.id)}
                >
                  {applying ? '正在加入…' : '加入行程'}
                </button>
              </article>
            );
          })}
        </div>
        {applyError && (
          <p className="meal-options-sheet__feedback" role="status">{applyError}</p>
        )}
      </aside>
    </div>
  );
}
