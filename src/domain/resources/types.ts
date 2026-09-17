export interface TravelResourceOption {
  id: string;
  provider: string;
  providerOptionId: string;
  title: string;
  bookingUrl: string;
  fetchedAt: string;
  expiresAt?: string;
}

export interface HotelOption extends TravelResourceOption {
  address: string;
  nightlyPrice: number;
}

export interface FlightOption extends TravelResourceOption {
  origin: string;
  destination: string;
  departAt: string;
  arriveAt: string;
  price: number;
}

export interface TrainOption extends TravelResourceOption {
  originStation: string;
  destinationStation: string;
  departAt: string;
  arriveAt: string;
  price: number;
}

export interface TicketOption extends TravelResourceOption {
  placeId: string;
  visitDate: string;
  price: number;
}
