import type { Trip } from '../domain/trip/types';

export const HOME_INSPIRATION_CHIPS = [
  '周末短途',
  '城市漫步',
  '美食旅行',
  '海边度假',
] as const;

export function applyInspirationChip(current: string, chip: string): string {
  const trimmed = current.trim();
  if (!trimmed) {
    return chip;
  }
  if (trimmed.includes(chip)) {
    return current;
  }
  return `${trimmed}，${chip}`;
}

export function tripCoverTone(destination: string): number {
  let hash = 0;
  for (const character of destination) {
    hash = (hash + character.charCodeAt(0) * 7) % 4;
  }
  return hash;
}

export function tripHomeStatusLabel(trip: Trip): string | null {
  return trip.status === 'PLANNING' ? '规划中' : null;
}

export function tripCoverInitial(destination: string): string {
  const visible = destination.trim();
  return visible ? visible.slice(0, 1) : '随';
}
