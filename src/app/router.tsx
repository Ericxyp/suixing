import { createBrowserRouter } from 'react-router-dom';
import { AppShell } from './AppShell';
import { HomePage } from '../pages/HomePage';
import { NotFoundPage } from '../pages/NotFoundPage';
import { TripDetailPage } from '../pages/TripDetailPage';
import { TripRequirementsConfirmPage } from '../pages/TripRequirementsConfirmPage';
import { PlanConversationPage } from '../pages/PlanConversationPage';

export const router = createBrowserRouter([
  {
    path: '/plan/new',
    element: <PlanConversationPage />,
  },
  {
    element: <AppShell />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/trips/:tripId', element: <TripDetailPage /> },
      { path: '/trips/new/confirm', element: <TripRequirementsConfirmPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
