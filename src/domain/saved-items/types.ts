export type SavedItemType = 'place' | 'destination' | 'route';

export interface SavedItem {
  id: string;
  userId: string;
  type: SavedItemType;
  title: string;
  subtitle?: string;
  destination?: string;
  placeId?: string;
  imageUrl?: string;
  tags?: string[];
  createdAt: string;
}
