<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import useClickOutside from "~/composables/useClickOutside";

const container = ref(undefined);
const optionsList = ref(undefined);
const optionSelected = ref(undefined);

const props = defineProps({
  modelValue: {
    type: String,
    default: '',
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
  light: {
    type: Boolean,
    default: false,
  },
  disabled: {
    type: Boolean,
    default: false,
  },
  buttonText: {
    type: String,
    default: 'Rechercher',
  },
  icon: {
    type: String,
    default: 'ri-search-line',
  },
});

const emit = defineEmits(['update:modelValue', 'search']);

const hasFocus = ref(false);
const displayOptions = computed(() => !!props.options.length);

function convertRemToPixels(rem) {
  return rem * parseFloat(getComputedStyle(document.documentElement).fontSize);
}

function selectOption(option) {
  optionSelected.value = option;
  emit('update:modelValue', option);
  hasFocus.value = false;
}

const displayAtTheTop = ref(false);

const looseFocus = () => {
  setTimeout(() => {
    hasFocus.value = false;
  }, 100);
};

watch(displayOptions, () => {
  if (displayOptions.value) {
    const posContainerY = container.value.offsetTop;
    const containerHeight = container.value.offsetHeight;
    const screenHeight = document.body.scrollHeight;
    const optionsHeight = convertRemToPixels(17);
    const isTooLow = optionsHeight + posContainerY + containerHeight > screenHeight;

    displayAtTheTop.value = isTooLow;
  }
});

const activeOption = ref(-1);

const isVisible = function (ele, container) {
  const { bottom, height, top } = ele.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();

  return top <= containerRect.top ? containerRect.top - top <= height : bottom - containerRect.bottom <= height;
};

function checkIfActiveOptionIsVisible() {
  const activeLi = optionsList.value.querySelectorAll('li')[activeOption.value];
  const isLiVisible = isVisible(activeLi, optionsList.value);

  if (!isLiVisible) {
    // Scroll to activeLi
    activeLi.scrollIntoView({ behavior: 'smooth' });
  }
}

function moveToPreviousOption() {
  const isFirst = activeOption.value <= 0;
  activeOption.value = isFirst ? props.options.length - 1 : activeOption.value - 1;
  nextTick().then(checkIfActiveOptionIsVisible);
}

function moveToNextOption() {
  const isLast = activeOption.value >= props.options.length - 1;
  activeOption.value = isLast ? 0 : activeOption.value + 1;
  nextTick().then(checkIfActiveOptionIsVisible);
}

function checkKeyboardNav($event) {
  if (['ArrowUp', 'ArrowDown', 'Enter'].includes($event.key)) {
    $event.preventDefault();
  }
  if ($event.key === 'Enter') {
    selectOption(props.options[activeOption.value > 0 ? activeOption.value : 0]);
  } else if ($event.key === 'ArrowUp') {
    moveToPreviousOption();
  } else if ($event.key === 'ArrowDown') {
    moveToNextOption();
  } else if ($event.key === 'search') {
    if (displayOptions.value && hasFocus.value) {
      selectOption(props.options[activeOption.value > 0 ? activeOption.value : 0]);
    }
  }
}

function displayOption(option: any) {
  if (!props.displayKey) {
    return option;
  }
  const keys = props.displayKey.split('.');
  let toDisplay = option;
  keys.forEach((k) => {
    toDisplay = toDisplay[k];
  });
  return toDisplay;
}

useClickOutside(
  container,
  () => looseFocus(),
  null
)
</script>

<template>
  <div ref="container"
       class="relative search-autocomplete">
    <div
      class="fr-search-bar"
      :class="{ 'fr-search-bar--lg': !light }"
      role="search"
    >
      <DsfrInput
        :model-value="modelValue"
        :placeholder="placeholder"
        :label="label"
        v-bind="$attrs"
        :disabled="disabled"
        @update:model-value="$emit('update:modelValue', $event)"
        ref="input"
        @focus="hasFocus = true"
        @keydown="checkKeyboardNav($event)"
        @search="checkKeyboardNav({ key: 'search' })"
      />
      <DsfrButton
        :title="buttonText"
        :disabled="disabled"
        type="button"
        @click="checkKeyboardNav({ key: 'search' })"
      >
        <VIcon :name="icon" class="fr-mr-1w" />
        {{ buttonText }}
      </DsfrButton>
    </div>
    <ul
      v-show="displayOptions && hasFocus"
      ref="optionsList"
      class="list-none absolute m-0 right-0 z-1 left-0 bg-white box-shadow max-h-17 scroll pointer"
      :class="{ 'at-the-top': displayAtTheTop }"
    >
      <li
        v-for="(option, i) of options"
        :key="option"
        class="list-item fr-p-1w fr-pl-2w"
        :class="{ 'active-option': activeOption === i }"
        @click.stop="selectOption(option)"
        v-html="displayOption(option)"
      ></li>
    </ul>
  </div>
</template>

<style scoped lang="scss">
.box-shadow {
  box-shadow:
    0px 16px 16px -16px rgba(0, 0, 0, 0.32),
    0px 8px 16px rgba(0, 0, 0, 0.1);
}

.max-h-17 {
  max-height: 17rem;
}

.scroll {
  overflow: auto;
}

.at-the-top {
  bottom: 2.8rem;
  box-shadow:
    0px -16px 16px -16px rgba(0, 0, 0, 0.32),
    0px -8px 16px rgba(0, 0, 0, 0.1);
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

    li {
      cursor: pointer;
    }
  }

  .fr-search-bar .fr-btn:before {
    display: none;
  }
}
</style>
