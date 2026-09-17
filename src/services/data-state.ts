/**
 * Small UI-facing async state union. Pages can render loading, absence and
 * failures explicitly without coupling to a request library.
 */
export type DataState<T> =
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'empty' }
  | { status: 'not-found' }
  | { status: 'error'; error: Error };

export const loading = <T>(): DataState<T> => ({ status: 'loading' });
export const success = <T>(data: T): DataState<T> => ({ status: 'success', data });
export const empty = <T>(): DataState<T> => ({ status: 'empty' });
export const notFound = <T>(): DataState<T> => ({ status: 'not-found' });
export const failure = <T>(error: Error): DataState<T> => ({ status: 'error', error });
