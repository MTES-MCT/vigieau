export interface RestrictionPopupEntry {
  badgeLabel: unknown;
  rank: number;
  zoneName: unknown;
}

export interface CommunePopupStatistics {
  noDays: number;
  vigilanceDays: number;
  alerteDays: number;
  alerteRenforceeDays: number;
  criseDays: number;
  nbDays: number;
}

interface PointPopupOptions {
  addressLabel?: unknown;
  communeName?: unknown;
  communeCode?: unknown;
}

interface StatsPopupOptions {
  name: unknown;
  code?: unknown;
  summary: unknown;
}

const asText = (value: unknown): string => {
  return value === null || value === undefined ? '' : String(value);
};

const getDocument = (ownerDocument?: Document): Document => {
  return ownerDocument ?? document;
};

const createTextElement = <TagName extends keyof HTMLElementTagNameMap>(
  ownerDocument: Document,
  tagName: TagName,
  text: unknown,
  className?: string,
): HTMLElementTagNameMap[TagName] => {
  const element = ownerDocument.createElement(tagName);
  if (className) {
    element.className = className;
  }
  element.textContent = asText(text);
  return element;
};

const appendPopupButton = (
  root: HTMLElement,
  label: string,
  ownerDocument: Document,
) => {
  const container = ownerDocument.createElement('div');
  const button = createTextElement(ownerDocument, 'button', label);
  button.className = 'fr-btn btn-map-popup';
  button.type = 'button';
  container.append(button);
  root.append(container);
};

export function createPointSelectionPopupContent(
  options: PointPopupOptions,
  ownerDocument?: Document,
): HTMLElement {
  const popupDocument = getDocument(ownerDocument);
  const root = popupDocument.createElement('div');
  const addressLabel = asText(options.addressLabel);
  const communeCode = asText(options.communeCode);
  let location = '';

  if (addressLabel) {
    location = `Adresse proche\u00A0: ${addressLabel}`;
  } else if (communeCode) {
    location = `Commune\u00A0: ${asText(options.communeName)} (${communeCode})`;
  }

  if (location) {
    root.append(
      createTextElement(
        popupDocument,
        'p',
        location,
        'fr-mb-2w',
      ),
    );
  }

  appendPopupButton(root, 'Sélectionner ce point', popupDocument);
  return root;
}

export function createRestrictionsPopupContent(
  entries: RestrictionPopupEntry[],
  showRestrictionsButton: boolean,
  location: unknown,
  ownerDocument?: Document,
): HTMLElement {
  const popupDocument = getDocument(ownerDocument);
  const root = popupDocument.createElement('div');

  if (entries.length > 0) {
    entries.forEach((entry, index) => {
      if (index > 0) {
        root.append(
          createTextElement(
            popupDocument,
            'div',
            '',
            'divider fr-my-1w',
          ),
        );
      }

      const badgeContainer = popupDocument.createElement('div');
      badgeContainer.className = 'fr-mb-1w';
      badgeContainer.append(
        createTextElement(
          popupDocument,
          'p',
          entry.badgeLabel,
          `fr-badge situation-level-bg-${entry.rank}`,
        ),
      );
      root.append(
        badgeContainer,
        createTextElement(
          popupDocument,
          'div',
          `Zone\u00A0: ${asText(entry.zoneName)}`,
          'map-popup-zone',
        ),
      );
    });
  } else {
    const badgeContainer = popupDocument.createElement('div');
    badgeContainer.className = 'fr-mb-1w';
    badgeContainer.append(
      createTextElement(
        popupDocument,
        'p',
        'Pas de restrictions',
        'fr-badge situation-level-bg-0',
      ),
    );
    root.append(badgeContainer);
  }

  root.append(
    createTextElement(
      popupDocument,
      'div',
      location,
      'fr-my-1w',
    ),
  );

  if (showRestrictionsButton) {
    appendPopupButton(
      root,
      'Je consulte les restrictions',
      popupDocument,
    );
  }

  return root;
}

export function createCommunePopupContent(
  communeName: unknown,
  ownerDocument?: Document,
): HTMLElement {
  const popupDocument = getDocument(ownerDocument);
  const root = popupDocument.createElement('div');
  const loader = popupDocument.createElement('div');
  loader.className = 'lds-ring';
  for (let index = 0; index < 4; index += 1) {
    loader.append(popupDocument.createElement('div'));
  }

  root.append(
    createTextElement(
      popupDocument,
      'div',
      communeName,
      'map-popup-zone',
    ),
    loader,
  );
  appendPopupButton(root, "Voir l'historique", popupDocument);
  return root;
}

export function createFullCommunePopupContent(
  communeName: unknown,
  data: CommunePopupStatistics,
  ownerDocument?: Document,
): HTMLElement {
  const popupDocument = getDocument(ownerDocument);
  const root = popupDocument.createElement('div');
  const list = popupDocument.createElement('ul');
  list.className = 'text-align-left';
  const rows: Array<[string, number]> = [
    ['Jours sans restrictions', data.noDays],
    ['Jours en vigilance', data.vigilanceDays],
    ['Jours en alerte', data.alerteDays],
    ['Jours en alerte renforcée', data.alerteRenforceeDays],
    ['Jours en crise', data.criseDays],
  ];

  for (const [label, value] of rows) {
    list.append(
      createTextElement(
        popupDocument,
        'li',
        `${label}\u00A0: ${value} (${Math.round(
          (value / data.nbDays) * 100,
        )}%)`,
      ),
    );
  }

  root.append(
    createTextElement(
      popupDocument,
      'div',
      communeName,
      'map-popup-zone',
    ),
    list,
  );
  appendPopupButton(root, "Voir l'historique", popupDocument);
  return root;
}

export function createStatsPopupContent(
  options: StatsPopupOptions,
  ownerDocument?: Document,
): HTMLElement {
  const popupDocument = getDocument(ownerDocument);
  const root = popupDocument.createElement('div');
  const code = asText(options.code);
  const name = asText(options.name);

  root.append(
    createTextElement(
      popupDocument,
      'div',
      code ? `${name} (${code})` : name,
    ),
    createTextElement(popupDocument, 'div', options.summary),
  );
  return root;
}
