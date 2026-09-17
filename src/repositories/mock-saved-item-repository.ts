import type { SavedItem } from '../domain/saved-items/types';
import { mockSavedItems } from '../mocks/saved-items';
import type { SavedItemRepository } from './saved-item-repository';

export class MockSavedItemRepository implements SavedItemRepository {
  async getSavedItems(userId: string): Promise<SavedItem[]> {
    return structuredClone(mockSavedItems.filter((item) => item.userId === userId));
  }
}

export const savedItemRepository: SavedItemRepository = new MockSavedItemRepository();
