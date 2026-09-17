import { FormEvent, useState, type ReactNode } from 'react';
import type { TripRequirementDraft } from '../../domain/trip/ai';
import type { TripPace } from '../../domain/trip/types';
import { formatSummaryEditIntent } from '../../services/plan-conversation-service';

const PACE_LABEL: Record<TripPace, string> = {
  relaxed: '轻松',
  balanced: '均衡',
  packed: '紧凑',
};

function displayValue(value: string | number | undefined, fallback = '待补充'): string {
  if (value === undefined || value === '') {
    return fallback;
  }
  return String(value);
}

function splitList(value: string): string[] {
  return value.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
}

export function TravelSummary({
  draft,
  complete,
  locked = false,
  onDraftCommit,
}: {
  draft: TripRequirementDraft;
  complete: boolean;
  locked?: boolean;
  onDraftCommit: (draft: TripRequirementDraft, intentMessage: string) => void;
}) {
  const [editing, setEditing] = useState<keyof TripRequirementDraft | 'preferences' | null>(null);

  function commit(next: TripRequirementDraft, field: keyof TripRequirementDraft | 'preferences') {
    onDraftCommit(next, formatSummaryEditIntent(field, next));
    setEditing(null);
  }

  function submitField(
    event: FormEvent<HTMLFormElement>,
    field: keyof TripRequirementDraft | 'preferences',
    next: TripRequirementDraft,
  ) {
    event.preventDefault();
    commit(next, field);
  }

  return (
    <aside className="travel-summary">
      <p className="eyebrow">本次旅行{complete ? ' · 信息已齐全' : ''}</p>
      <h2>旅行信息</h2>
      <SummaryRow
        label="目的地"
        value={displayValue(draft.destination)}
        editing={editing === 'destination'}
        onEdit={() => setEditing('destination')}
        onCancel={() => setEditing(null)}
        locked={locked}
      >
        <form onSubmit={(event) => submitField(event, 'destination', {
          ...draft,
          destination: String(new FormData(event.currentTarget).get('value') ?? '').trim() || undefined,
        })}>
          <input name="value" defaultValue={draft.destination ?? ''} />
          <button type="submit">保存</button>
        </form>
      </SummaryRow>
      <SummaryRow
        label="出发地"
        value={displayValue(draft.origin)}
        editing={editing === 'origin'}
        onEdit={() => setEditing('origin')}
        onCancel={() => setEditing(null)}
        locked={locked}
      >
        <form onSubmit={(event) => submitField(event, 'origin', {
          ...draft,
          origin: String(new FormData(event.currentTarget).get('value') ?? '').trim() || undefined,
        })}>
          <input name="value" defaultValue={draft.origin ?? ''} />
          <button type="submit">保存</button>
        </form>
      </SummaryRow>
      <SummaryRow
        label="日期"
        value={draft.startDate || draft.endDate
          ? `${displayValue(draft.startDate, '未定')} — ${displayValue(draft.endDate, '未定')}`
          : '待补充'}
        editing={editing === 'startDate'}
        onEdit={() => setEditing('startDate')}
        onCancel={() => setEditing(null)}
        locked={locked}
      >
        <form onSubmit={(event) => {
          const data = new FormData(event.currentTarget);
          submitField(event, 'startDate', {
            ...draft,
            startDate: String(data.get('start') ?? '') || undefined,
            endDate: String(data.get('end') ?? '') || undefined,
          });
        }}>
          <input type="date" name="start" defaultValue={draft.startDate ?? ''} />
          <input type="date" name="end" defaultValue={draft.endDate ?? ''} />
          <button type="submit">保存</button>
        </form>
      </SummaryRow>
      <SummaryRow
        label="天数"
        value={draft.durationDays ? `${draft.durationDays} 天` : '待补充'}
        editing={editing === 'durationDays'}
        onEdit={() => setEditing('durationDays')}
        onCancel={() => setEditing(null)}
        locked={locked}
      >
        <form onSubmit={(event) => submitField(event, 'durationDays', {
          ...draft,
          durationDays: Number(new FormData(event.currentTarget).get('value')) || undefined,
        })}>
          <input type="number" min="1" name="value" defaultValue={draft.durationDays ?? ''} />
          <button type="submit">保存</button>
        </form>
      </SummaryRow>
      <SummaryRow
        label="人数"
        value={draft.travelerCount ? `${draft.travelerCount} 人` : '待补充'}
        editing={editing === 'travelerCount'}
        onEdit={() => setEditing('travelerCount')}
        onCancel={() => setEditing(null)}
        locked={locked}
      >
        <form onSubmit={(event) => submitField(event, 'travelerCount', {
          ...draft,
          travelerCount: Number(new FormData(event.currentTarget).get('value')) || undefined,
        })}>
          <input type="number" min="1" name="value" defaultValue={draft.travelerCount ?? ''} />
          <button type="submit">保存</button>
        </form>
      </SummaryRow>
      <SummaryRow
        label="总预算"
        value={draft.totalBudget ? `¥${draft.totalBudget.toLocaleString('zh-CN')}` : '待补充'}
        editing={editing === 'totalBudget'}
        onEdit={() => setEditing('totalBudget')}
        onCancel={() => setEditing(null)}
        locked={locked}
      >
        <form onSubmit={(event) => submitField(event, 'totalBudget', {
          ...draft,
          totalBudget: Number(new FormData(event.currentTarget).get('value')) || undefined,
        })}>
          <input type="number" min="1" name="value" defaultValue={draft.totalBudget ?? ''} />
          <button type="submit">保存</button>
        </form>
      </SummaryRow>
      <SummaryRow
        label="节奏"
        value={draft.pace ? PACE_LABEL[draft.pace] : '待补充'}
        editing={editing === 'pace'}
        onEdit={() => setEditing('pace')}
        onCancel={() => setEditing(null)}
        locked={locked}
      >
        <form onSubmit={(event) => submitField(event, 'pace', {
          ...draft,
          pace: String(new FormData(event.currentTarget).get('value')) as TripPace,
        })}>
          <select name="value" defaultValue={draft.pace ?? 'balanced'}>
            <option value="relaxed">轻松</option>
            <option value="balanced">均衡</option>
            <option value="packed">紧凑</option>
          </select>
          <button type="submit">保存</button>
        </form>
      </SummaryRow>
      <SummaryRow
        label="兴趣"
        value={draft.preferences?.interests?.length
          ? draft.preferences.interests.join('、')
          : '待补充'}
        editing={editing === 'preferences'}
        onEdit={() => setEditing('preferences')}
        onCancel={() => setEditing(null)}
        locked={locked}
      >
        <form onSubmit={(event) => submitField(event, 'preferences', {
          ...draft,
          preferences: {
            ...draft.preferences,
            interests: splitList(String(new FormData(event.currentTarget).get('value') ?? '')),
          },
        })}>
          <input name="value" defaultValue={draft.preferences?.interests.join('，') ?? ''} />
          <button type="submit">保存</button>
        </form>
      </SummaryRow>
    </aside>
  );
}

function SummaryRow({
  label,
  value,
  editing,
  locked = false,
  onEdit,
  onCancel,
  children,
}: {
  label: string;
  value: string;
  editing: boolean;
  locked?: boolean;
  onEdit: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  return (
    <div className="travel-summary__row">
      <div className="travel-summary__heading">
        <span>{label}</span>
        {editing
          ? <button type="button" className="text-button travel-summary__edit" onClick={onCancel}>取消</button>
          : (
            <button
              type="button"
              className="text-button travel-summary__edit"
              onClick={onEdit}
              disabled={locked}
            >
              修改
            </button>
          )}
      </div>
      {editing ? children : <p>{value}</p>}
    </div>
  );
}
