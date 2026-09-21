import { useState } from 'react';
import type { TripRequirementDraft } from '../../domain/trip/ai';
import {
  TRAVEL_INTEREST_KEYS,
  TRAVEL_PARTY_TYPES,
  type TravelInterestKey,
  type TravelPartyType,
} from '../../domain/trip/profile';
import type { TripPace } from '../../domain/trip/types';
import {
  applyTripStyleToRequirementDraft,
  tripStyleEditorState,
  TRIP_STYLE_INTEREST_LABELS,
  TRIP_STYLE_PACE_LABELS,
  TRIP_STYLE_PARTY_LABELS,
} from '../../services/trip-style-display';

const PARTY_OPTIONS: Array<{ value: '' | TravelPartyType; label: string }> = [
  { value: '', label: '不选择' },
  ...TRAVEL_PARTY_TYPES.map((value) => ({
    value,
    label: TRIP_STYLE_PARTY_LABELS[value] ?? '其他同行',
  })),
];

function toggleKey(
  list: TravelInterestKey[],
  key: TravelInterestKey,
  limit: number,
): TravelInterestKey[] {
  if (list.includes(key)) {
    return list.filter((item) => item !== key);
  }
  if (list.length >= limit) {
    return list;
  }
  return [...list, key];
}

export function TripStyleEditor({
  draft,
  onSave,
  onCancel,
}: {
  draft: TripRequirementDraft;
  onSave: (next: TripRequirementDraft) => void;
  onCancel: () => void;
}) {
  const initial = tripStyleEditorState(draft);
  const [interestKeys, setInterestKeys] = useState(initial.interestKeys);
  const [pace, setPace] = useState<TripPace>(initial.pace);
  const [partyType, setPartyType] = useState<TravelPartyType | undefined>(initial.partyType);
  const [lowWalking, setLowWalking] = useState(initial.lowWalking);
  const [excludedInterestKeys, setExcludedInterestKeys] = useState(initial.excludedInterestKeys);

  function save() {
    onSave(applyTripStyleToRequirementDraft(draft, {
      interestKeys,
      pace,
      partyType,
      lowWalking,
      excludedInterestKeys,
    }));
  }

  return (
    <form
      className="trip-style-editor"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <p className="trip-style-editor__title">调整本次偏好</p>
      <fieldset>
        <legend>本次兴趣</legend>
        <div className="trip-style-editor__chips">
          {TRAVEL_INTEREST_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={interestKeys.includes(key)}
              onClick={() => setInterestKeys(toggleKey(interestKeys, key, 3))}
            >
              {TRIP_STYLE_INTEREST_LABELS[key]}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>节奏</legend>
        <div className="trip-style-editor__chips">
          {(Object.keys(TRIP_STYLE_PACE_LABELS) as TripPace[]).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={pace === value}
              onClick={() => setPace(value)}
            >
              {value === 'relaxed' ? '轻松' : value === 'packed' ? '紧凑' : '均衡'}
            </button>
          ))}
        </div>
      </fieldset>
      <label className="trip-style-editor__select">
        同行方式
        <select
          value={partyType ?? ''}
          onChange={(event) => {
            const value = event.target.value;
            setPartyType(value === '' ? undefined : value as TravelPartyType);
          }}
        >
          {PARTY_OPTIONS.map((option) => (
            <option key={option.value || 'none'} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      <label className="trip-style-editor__switch">
        <input
          type="checkbox"
          checked={lowWalking}
          onChange={(event) => setLowWalking(event.target.checked)}
        />
        少走路
      </label>
      <fieldset>
        <legend>避开内容</legend>
        <div className="trip-style-editor__chips">
          {TRAVEL_INTEREST_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={excludedInterestKeys.includes(key)}
              onClick={() => setExcludedInterestKeys(toggleKey(excludedInterestKeys, key, 2))}
            >
              {TRIP_STYLE_INTEREST_LABELS[key]}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="trip-style-editor__actions">
        <button type="button" className="text-button" onClick={onCancel}>取消</button>
        <button type="submit">保存本次偏好</button>
      </div>
    </form>
  );
}
