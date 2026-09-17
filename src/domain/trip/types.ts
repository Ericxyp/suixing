export type TripStatus = 'PLANNING' | 'READY' | 'TRAVELLING' | 'COMPLETED';

export type TripPace = 'relaxed' | 'balanced' | 'packed';

export type Currency = 'CNY';

export type TripPlaceType =
  | 'hotel'
  | 'attraction'
  | 'restaurant'
  | 'cafe'
  | 'transport'
  | 'shopping'
  | 'activity';

export type TransportMode = 'walk' | 'metro' | 'taxi' | 'bus' | 'drive';

export type PlaceProviderName = 'amap' | 'mock';

export interface TripPreference {
  interests: string[];
  accommodation?: string[];
  mustVisit?: string[];
  avoid?: string[];
}

export interface TransportSegment {
  mode: TransportMode;
  durationMinutes: number;
  distanceMeters: number;
  description?: string;
}

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface Place {
  id: string;
  provider: PlaceProviderName;
  providerPlaceId: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  category: TripPlaceType;
}

export interface TripPlace {
  id: string;
  dayId: string;
  order: number;
  placeId: string;
  placeName: string;
  type: TripPlaceType;
  startTime?: string;
  endTime?: string;
  durationMinutes?: number;
  description?: string;
  estimatedCost: number;
  transportToNext?: TransportSegment;
}

export type TripExperienceType = 'meal' | 'walk' | 'free_time' | 'night' | 'rest';

export type TripMealPeriod = 'lunch' | 'dinner';

export type TripDiningMode = 'flexible' | 'arranged' | 'self_managed';

export type TripScheduleItem =
  | {
      kind: 'place';
      tripPlaceId: string;
      startTime: string;
      durationMinutes: number;
    }
  | {
      kind: 'meal_slot';
      id: string;
      mealPeriod: TripMealPeriod;
      startTime: string;
      durationMinutes: number;
      areaTripPlaceId: string;
      nextTripPlaceId?: string;
      diningMode: 'flexible' | 'self_managed';
    }
  | {
      kind: 'meal_place';
      tripPlaceId: string;
      mealPeriod: TripMealPeriod;
      startTime: string;
      durationMinutes: number;
    }
  | {
      kind: 'meal';
      tripPlaceId: string;
      startTime: string;
      durationMinutes: number;
      mealPeriod: TripMealPeriod;
    }
  | {
      kind: 'rest';
      id: string;
      startTime: string;
      durationMinutes: number;
      title: '午间休息' | '参观后休息';
      description: string;
    }
  | {
      kind: 'area_walk';
      id: string;
      startTime: string;
      durationMinutes: number;
      areaTripPlaceId: string;
      optionTripPlaceIds: string[];
      title: string;
      description: string;
    }
  | {
      kind: 'hotel_return';
      id: string;
      startTime: string;
      durationMinutes: number;
      title: '返程准备';
      description: string;
    }
  | {
      kind: 'experience';
      id: string;
      startTime: string;
      durationMinutes: number;
      type: TripExperienceType;
      title: string;
      description: string;
    };

export interface TripDay {
  id: string;
  tripId: string;
  dayNumber: number;
  date: string;
  title?: string;
  summary?: string;
  places: TripPlace[];
  scheduleItems?: TripScheduleItem[];
}

export interface TripRoute {
  id: string;
  dayId: string;
  fromTripPlaceId: string;
  toTripPlaceId: string;
  transport: TransportSegment;
  polyline?: GeoPoint[];
}

export interface Trip {
  id: string;
  userId: string;
  title: string;
  destination: string;
  origin?: string;
  startDate?: string;
  endDate?: string;
  travelerCount: number;
  totalBudget: number;
  currency: Currency;
  pace: TripPace;
  preferences: TripPreference;
  status: TripStatus;
  days: TripDay[];
  routes: TripRoute[];
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessage {
  id: string;
  tripId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
}
