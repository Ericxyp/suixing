import type { SavedItem } from '../domain/saved-items/types';

export interface SavedItemRepository {
  getSavedItems(userId: string): Promise<SavedItem[]>;
}
