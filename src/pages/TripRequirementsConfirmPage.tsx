import { FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { TripRequirementDraft } from '../domain/trip/ai';
import type { TripPreference } from '../domain/trip/types';
import { tripRepository } from '../repositories/local-storage-trip-repository';
import { tripRequirementDraftStore } from '../services/trip-requirement-draft-store';

const userId = 'user-demo-001';
const split = (value: string) => value.split(/[,，]/).map((item) => item.trim()).filter(Boolean);

export function TripRequirementsConfirmPage() {
  const saved = tripRequirementDraftStore.load();
  const [draft, setDraft] = useState<TripRequirementDraft>(saved?.draft ?? {});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const preferences = (updates: Partial<TripPreference>): TripPreference => ({
    interests: draft.preferences?.interests ?? [],
    ...draft.preferences,
    ...updates,
  });

  if (!saved) {
    return <section className="entry-page"><h1>没有待确认的旅行需求</h1><p>请先从首页描述你的旅行计划。</p><Link className="text-link" to="/">返回首页</Link></section>;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    if (!draft.destination?.trim()) nextErrors.destination = '请填写目的地。';
    if (!draft.durationDays && !(draft.startDate && draft.endDate)) nextErrors.durationDays = '请填写日期范围或行程天数。';
    if (!draft.travelerCount || draft.travelerCount < 1) nextErrors.travelerCount = '请填写至少 1 位同行人。';
    if (!draft.totalBudget || draft.totalBudget <= 0) nextErrors.totalBudget = '请填写大于 0 的总预算。';
    if (draft.startDate && draft.endDate && draft.endDate < draft.startDate) nextErrors.endDate = '结束日期不能早于开始日期。';
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    setSubmitting(true);
    try {
      const trip = await tripRepository.createTrip({
        userId,
        requirements: {
          ...draft,
          destination: draft.destination!.trim(),
          travelerCount: draft.travelerCount!,
          totalBudget: draft.totalBudget!,
          pace: draft.pace ?? 'balanced',
        },
      });
      tripRequirementDraftStore.clear();
      navigate(`/trips/${trip.id}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="confirm-page">
      <p className="eyebrow">兼容入口</p>
      <h1>确认你的旅行计划</h1>
      <p className="section-description">日常规划请从首页开始。此页保留给深链接与既有确认流程。</p>
      <form className="confirm-form" onSubmit={submit}>
        <Field label="目的地" error={errors.destination}><input value={draft.destination ?? ''} onChange={(e) => setDraft({ ...draft, destination: e.target.value })} /></Field>
        <Field label="出发地"><input value={draft.origin ?? ''} onChange={(e) => setDraft({ ...draft, origin: e.target.value })} /></Field>
        <Field label="开始日期"><input type="date" value={draft.startDate ?? ''} onChange={(e) => setDraft({ ...draft, startDate: e.target.value })} /></Field>
        <Field label="结束日期" error={errors.endDate}><input type="date" value={draft.endDate ?? ''} onChange={(e) => setDraft({ ...draft, endDate: e.target.value })} /></Field>
        <Field label="行程天数" error={errors.durationDays}><input type="number" min="1" value={draft.durationDays ?? ''} onChange={(e) => setDraft({ ...draft, durationDays: Number(e.target.value) || undefined })} /></Field>
        <Field label="同行人数" error={errors.travelerCount}><input type="number" min="1" value={draft.travelerCount ?? ''} onChange={(e) => setDraft({ ...draft, travelerCount: Number(e.target.value) || undefined })} /></Field>
        <Field label="总预算（人民币）" error={errors.totalBudget}><input type="number" min="1" value={draft.totalBudget ?? ''} onChange={(e) => setDraft({ ...draft, totalBudget: Number(e.target.value) || undefined })} /></Field>
        <Field label="行程节奏"><select value={draft.pace ?? 'balanced'} onChange={(e) => setDraft({ ...draft, pace: e.target.value as TripRequirementDraft['pace'] })}><option value="relaxed">轻松</option><option value="balanced">均衡</option><option value="packed">紧凑</option></select></Field>
        <Field label="兴趣偏好（逗号分隔）"><input value={draft.preferences?.interests.join('，') ?? ''} onChange={(e) => setDraft({ ...draft, preferences: preferences({ interests: split(e.target.value) }) })} /></Field>
        <Field label="住宿偏好（逗号分隔）"><input value={draft.preferences?.accommodation?.join('，') ?? ''} onChange={(e) => setDraft({ ...draft, preferences: preferences({ accommodation: split(e.target.value) }) })} /></Field>
        <Field label="必去地点（逗号分隔）"><input value={draft.preferences?.mustVisit?.join('，') ?? ''} onChange={(e) => setDraft({ ...draft, preferences: preferences({ mustVisit: split(e.target.value) }) })} /></Field>
        <Field label="不希望出现的内容（逗号分隔）"><input value={draft.preferences?.avoid?.join('，') ?? ''} onChange={(e) => setDraft({ ...draft, preferences: preferences({ avoid: split(e.target.value) }) })} /></Field>
        <button type="submit" disabled={submitting}>{submitting ? '正在创建…' : '生成旅行方案'}</button>
      </form>
    </section>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return <label className="confirm-field"><span>{label}</span>{children}{error && <small>{error}</small>}</label>;
}
