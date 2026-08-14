import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const mainStyles = readFileSync(
  new URL('../client/assets/main.scss', import.meta.url),
  'utf8',
);
const situationHeader = readFileSync(
  new URL('../client/components/situation/Header.vue', import.meta.url),
  'utf8',
);

function colorVariable(name) {
  const match = mainStyles.match(
    new RegExp(`--${name}:\\s*(#[0-9a-f]{3,6});`, 'i'),
  );

  assert.ok(match, `La variable CSS --${name} doit contenir une couleur hexadécimale`);
  return match[1];
}

function rgb(hexColor) {
  const hex = hexColor.slice(1);
  const normalized = hex.length === 3
    ? [...hex].map(character => character.repeat(2)).join('')
    : hex;

  return [0, 2, 4].map(offset => Number.parseInt(normalized.slice(offset, offset + 2), 16));
}

function relativeLuminance(hexColor) {
  const channels = rgb(hexColor).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(firstColor, secondColor) {
  const luminances = [
    relativeLuminance(firstColor),
    relativeLuminance(secondColor),
  ].sort((first, second) => second - first);

  return (luminances[0] + 0.05) / (luminances[1] + 0.05);
}

function compositeOverWhite(hexColor, opacity) {
  const channels = rgb(hexColor).map(channel => Math.round(
    channel * opacity + 255 * (1 - opacity),
  ));

  return `#${channels.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
}

const levelBackgrounds = Array.from({ length: 5 }, (_, level) => (
  colorVariable(`situation-level-${level}-background`)
));
const levelTextColors = Array.from({ length: 5 }, (_, level) => (
  colorVariable(`situation-level-${level}-text`)
));
const textOnLightBackground = colorVariable('situation-level-text-on-light-background');
const textOnDarkBackground = colorVariable('situation-level-text-on-dark-background');

test('keeps every situation badge label above the 4.5:1 contrast threshold', () => {
  levelBackgrounds.forEach((background, level) => {
    const foreground = level === 4
      ? textOnDarkBackground
      : textOnLightBackground;
    const ratio = contrastRatio(foreground, background);

    assert.ok(
      ratio >= 4.5,
      `Le badge du niveau ${level} n'atteint que ${ratio.toFixed(3)}:1`,
    );
    assert.match(
      mainStyles,
      new RegExp(`background-color:\\s*var\\(--situation-level-${level}-background\\)`),
      `Le niveau ${level} doit utiliser la couleur de fond testée`,
    );
  });
});

test('keeps level text readable on the default and tinted header surfaces', () => {
  const headerSurfaces = [
    { colors: ['#e8edff', '#f5f5fe'], opacity: 1 },
    { colors: ['#fef5e8', '#f4f6fe'], opacity: 0.5 },
    { colors: ['#fef5e8', '#feebd0'], opacity: 0.3 },
    { colors: ['#fef6e3', '#fddfda'], opacity: 0.5 },
    { colors: ['#fddfda', '#fcc0b4'], opacity: 0.5 },
  ];

  levelTextColors.forEach((foreground, level) => {
    const surfaces = [
      '#ffffff',
      ...headerSurfaces[level].colors.map(color => (
        compositeOverWhite(color, headerSurfaces[level].opacity)
      )),
    ];

    surfaces.forEach((background) => {
      const ratio = contrastRatio(foreground, background);
      assert.ok(
        ratio >= 4.5,
        `Le texte du niveau ${level} n'atteint que ${ratio.toFixed(3)}:1 sur ${background}`,
      );
    });
    assert.match(
      mainStyles,
      new RegExp(`color:\\s*var\\(--situation-level-${level}-text\\)`),
      `Le niveau ${level} doit utiliser la couleur de texte testée`,
    );
  });
});

test('keeps the situation header on the tested central palette', () => {
  assert.doesNotMatch(situationHeader, /#a18e3a/i);
  assert.doesNotMatch(
    situationHeader,
    /\.situation-level-c-[0-4]\s*\{[^}]*color\s*:/,
  );
});
