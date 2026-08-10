export type HorizontalTabNavigationKey =
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'Home'
  | 'End';

export const getHorizontalTabIndex = (
  currentIndex: number,
  tabCount: number,
  key: string,
): number | null => {
  if (tabCount < 1) {
    return null;
  }

  switch (key as HorizontalTabNavigationKey) {
    case 'ArrowLeft':
      return (currentIndex - 1 + tabCount) % tabCount;
    case 'ArrowRight':
      return (currentIndex + 1) % tabCount;
    case 'Home':
      return 0;
    case 'End':
      return tabCount - 1;
    default:
      return null;
  }
};
