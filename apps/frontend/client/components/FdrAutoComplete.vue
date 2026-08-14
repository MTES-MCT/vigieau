<script setup lang="ts">
import {
  computed,
  nextTick,
  type Ref,
  ref,
  useAttrs,
  useId,
  watch,
} from 'vue';
import { moveActiveOption } from '../utils/address-combobox';

defineOptions({ inheritAttrs: false });

const props = defineProps({
  modelValue: {
    type: String,
    default: '',
  },
  required: {
    type: Boolean,
    default: false,
  },
  options: {
    type: Array,
    default: () => [],
  },
  displayKey: {
    type: String,
    default: () => null,
  },
  placeholder: {
    type: String,
    default: '',
  },
  label: {
    type: String,
    default: '',
  },
  ariaLabelList: {
    type: String,
    default: 'Suggestions d’adresses',
  },
  light: {
    type: Boolean,
    default: false,
  },
  disabled: {
    type: Boolean,
    default: false,
  },
  dataCy: {
    type: String,
    default: '',
  },
  statusMessage: {
    type: String,
    default: '',
  },
});

const emit = defineEmits(['update:modelValue', 'search']);

const attrs = useAttrs();
const generatedId = useId();
const container: Ref<HTMLElement | null> = ref(null);
const optionsList: Ref<HTMLElement | null> = ref(null);
const inputSearchBar: Ref<HTMLInputElement | null> = ref(null);

const hasFocus = ref(false);
const isOpen = ref(false);
const displayOptions = computed(() => !!props.options.length);
const displayListbox = computed(() => (
  isOpen.value && displayOptions.value && !props.disabled
));
const inputId = computed(() => (
  typeof attrs.id === 'string' && attrs.id
    ? attrs.id
    : `${generatedId}-address-input`
));
const hintId = computed(() => `${inputId.value}-hint`);
const listboxId = computed(() => `${inputId.value}-listbox`);
const activeOption = ref(-1);
const activeOptionId = computed(() => (
  displayListbox.value && activeOption.value >= 0
    ? getOptionId(activeOption.value)
    : undefined
));
const describedBy = computed(() => {
  const externalDescription = typeof attrs['aria-describedby'] === 'string'
    ? attrs['aria-describedby'].trim()
    : '';
  return [props.placeholder ? hintId.value : '', externalDescription]
    .filter(Boolean)
    .join(' ') || undefined;
});
const controlledInputAttributes = new Set([
  'aria-autocomplete',
  'aria-controls',
  'aria-describedby',
  'aria-expanded',
  'aria-haspopup',
  'aria-label',
  'aria-labelledby',
  'autocomplete',
  'class',
  'disabled',
  'id',
  'required',
  'role',
  'style',
  'value',
]);
const forwardedInputAttrs = computed(() => Object.fromEntries(
  Object.entries(attrs).filter(([name]) => !controlledInputAttributes.has(name)),
));

function convertRemToPixels(rem) {
  return rem * Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
}

function getOptionId(index: number): string {
  return `${listboxId.value}-option-${index}`;
}

function closeListbox() {
  isOpen.value = false;
  activeOption.value = -1;
}

function focusInput() {
  inputSearchBar.value?.focus();
}

function selectOption(option, index: number) {
  if (option === undefined) {
    return;
  }

  activeOption.value = index;
  isOpen.value = false;
  emit('update:modelValue', option);
  nextTick(focusInput);
}

const displayAtTheTop = ref(false);

function updateListboxPosition() {
  if (!container.value || typeof document === 'undefined') {
    return;
  }

  const posContainerY = container.value.offsetTop;
  const containerHeight = container.value.offsetHeight;
  const screenHeight = document.body.scrollHeight;
  const optionsHeight = convertRemToPixels(17);
  displayAtTheTop.value = optionsHeight + posContainerY + containerHeight > screenHeight;
}

watch(displayListbox, async (isDisplayed) => {
  if (!isDisplayed) {
    return;
  }
  await nextTick();
  updateListboxPosition();
});

watch(() => props.options, () => {
  activeOption.value = -1;
  isOpen.value = hasFocus.value && displayOptions.value;
});

watch(() => props.disabled, (isDisabled) => {
  if (isDisabled) {
    closeListbox();
  }
});

const isVisible = function(ele, container) {
  const { bottom, height, top } = ele.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();

  return top <= containerRect.top
    ? containerRect.top - top <= height
    : bottom - containerRect.bottom <= height;
};

function checkIfActiveOptionIsVisible() {
  if (!optionsList.value || activeOption.value < 0) {
    return;
  }

  const activeLi = optionsList.value.querySelectorAll('li')[activeOption.value];
  if (!activeLi) {
    return;
  }
  const isLiVisible = isVisible(activeLi, optionsList.value);

  if (!isLiVisible && typeof activeLi.scrollIntoView === 'function') {
    activeLi.scrollIntoView({ block: 'nearest' });
  }
}

function moveOption(direction: 'next' | 'previous') {
  if (!displayOptions.value) {
    return;
  }

  isOpen.value = true;
  activeOption.value = moveActiveOption(
    activeOption.value,
    props.options.length,
    direction,
  );
  nextTick().then(checkIfActiveOptionIsVisible);
}

function handleInput(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  activeOption.value = -1;
  isOpen.value = hasFocus.value && displayOptions.value;
  emit('update:modelValue', value);
}

function handleFocus() {
  hasFocus.value = true;
  isOpen.value = displayOptions.value;
}

function handleBlur() {
  hasFocus.value = false;
  closeListbox();
}

function handleKeyboardNavigation(event: KeyboardEvent) {
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    if (!displayOptions.value) {
      return;
    }
    event.preventDefault();
    moveOption(event.key === 'ArrowUp' ? 'previous' : 'next');
    return;
  }

  if (event.key === 'Enter') {
    if (displayListbox.value && activeOption.value >= 0) {
      event.preventDefault();
      selectOption(props.options[activeOption.value], activeOption.value);
    }
    return;
  }

  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeListbox();
    return;
  }

  if (event.key === 'Tab') {
    closeListbox();
  }
}

function handleSearch() {
  const optionIndex = activeOption.value >= 0
    ? activeOption.value
    : props.options.length > 0
      ? 0
      : -1;

  if (optionIndex >= 0) {
    selectOption(props.options[optionIndex], optionIndex);
    return;
  }

  closeListbox();
  nextTick(focusInput);
}

function displayOption(option) {
  if (!props.displayKey) {
    return option;
  }
  const keys = props.displayKey.split('.');
  let toDisplay = option;
  keys.forEach(k => {
    toDisplay = toDisplay[k];
  });
  return toDisplay;
}

defineExpose({
  focusInput,
});

</script>

<template>
  <div
    ref="container"
    class="relative search-autocomplete"
    :class="$attrs.class"
    :style="$attrs.style"
    :data-cy="dataCy || undefined"
  >
    <div class="fr-search-bar">
      <label
        class="fr-label"
        :for="inputId"
      >
        {{ label }}
        <span
          v-if="required"
          class="required-marker"
        > (obligatoire)</span>
      </label>
      <p
        v-if="placeholder"
        :id="hintId"
        class="fr-hint-text autocomplete-hint"
      >
        {{ placeholder }}
      </p>
      <input
        v-bind="forwardedInputAttrs"
        :id="inputId"
        ref="inputSearchBar"
        class="fr-input"
        type="search"
        :value="modelValue"
        :required="required"
        :disabled="disabled"
        autocomplete="street-address"
        role="combobox"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        :aria-expanded="displayListbox"
        :aria-controls="listboxId"
        :aria-activedescendant="activeOptionId"
        :aria-describedby="describedBy"
        @input="handleInput"
        @focus="handleFocus"
        @blur="handleBlur"
        @keydown="handleKeyboardNavigation"
      >
      <button
        class="fr-btn"
        type="button"
        data-cy="AddressSearchSubmit"
        :disabled="disabled"
        :aria-disabled="disabled"
        @mousedown.prevent
        @click="handleSearch"
      >
        <span class="fr-sr-only">Rechercher une adresse</span>
      </button>
      <p
        class="fr-sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-cy="AddressSearchStatus"
      >
        {{ statusMessage }}
      </p>
      <ul
        v-show="displayListbox"
        :id="listboxId"
        ref="optionsList"
        role="listbox"
        :aria-label="ariaLabelList"
        class="list-none absolute m-0 right-0 z-1 left-0 bg-white box-shadow max-h-17 scroll pointer"
        :class="{'at-the-top': displayAtTheTop,}"
      >
        <li
          v-for="(option, i) of options"
          :id="getOptionId(i)"
          :key="`${displayOption(option)}-${i}`"
          role="option"
          :aria-selected="activeOption === i"
          class="list-item fr-p-1w fr-pl-2w"
          :class="{ 'active-option': activeOption === i }"
          @mouseenter="activeOption = i"
          @mousedown.prevent
          @click.stop="selectOption(option, i)"
        >
          {{ displayOption(option) }}
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped lang="scss">
.box-shadow {
  box-shadow: 0px 16px 16px -16px rgba(0, 0, 0, 0.32), 0px 8px 16px rgba(0, 0, 0, 0.1);
}

.max-h-17 {
  max-height: 17rem;
}

.scroll {
  overflow: auto;
}

.at-the-top {
  bottom: 2.8rem;
  box-shadow: 0px -16px 16px -16px rgba(0, 0, 0, 0.32), 0px -8px 16px rgba(0, 0, 0, 0.1);
}

.list-item.active-option,
.list-item:hover {
  background-color: var(--blue-france-sun-113-625);
  color: white;
}

.search-autocomplete {
  position: relative;

  ul {
    position: absolute;
    width: 100%;
    z-index: 10;
    background-color: var(--grey-950-100);
    list-style-type: none;
    margin-top: 0;
    padding: 0;
    text-align: left;
    top: 100%;

    li {
      cursor: pointer;
    }
  }
}

.fr-search-bar {
  flex-wrap: wrap;
  min-width: 0;
  width: 100%;
  max-width: 100%;

  .fr-label,
  .autocomplete-hint {
    flex: 0 0 100%;
    min-width: 0;
    max-width: 100%;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .fr-label {
    position: relative;
    width: 100%;
    height: auto;
    padding: 0;
    margin: 0;
    overflow: visible;
    clip: auto;
    white-space: normal;
    border: 0;
  }

  :deep(.fr-input), .fr-btn {
    margin-top: .5rem;
    flex: 1;
  }

  .fr-input {
    min-width: 0;
  }

  .required-marker {
    margin-left: 0.125rem;
  }

  /**
 * Obligé de faire ça car la couleur est codée en dur dans le DSFR
 * sans prendre en compte que ce champ pouvait être disabled.
 */
  .fr-input:disabled {
    box-shadow: inset 0 -2px 0 0 var(--border-disabled-grey);
    color: var(--text-disabled-grey);
  }
}
</style>
