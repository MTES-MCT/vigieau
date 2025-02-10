export interface AlertDto {
  id?: number;
  title?: string;
  type: 'success' | 'info' | 'warning' | 'error';
  description: string;
}