<script setup lang="ts">
import { Icon } from '@iconify/vue';
import {
  lockModalPageScroll,
  unlockModalPageScroll,
} from '../utils/modal-scroll-lock';
import { trapTabKey } from '../utils/focus-management';

interface FocusTarget {
  focus: (options?: FocusOptions) => void;
}

interface ModalAction {
  label: string;
  onClick?: (event: MouseEvent) => void | Promise<void>;
  [attribute: string]: unknown;
}

const props = withDefaults(
  defineProps<{
    actions?: ModalAction[];
    closeButtonLabel?: string;
    closeButtonTitle?: string;
    icon?: string | Record<string, unknown>;
    initialFocus?: string;
    isAlert?: boolean;
    modalId?: string;
    opened: boolean;
    origin?: FocusTarget;
    size?: 'sm' | 'md' | 'lg';
    title: string;
  }>(),
  {
    actions: () => [],
    closeButtonLabel: 'Fermer',
    closeButtonTitle: 'Fermer la boîte de dialogue',
    icon: undefined,
    initialFocus: undefined,
    isAlert: false,
    modalId: undefined,
    origin: undefined,
    size: 'md',
  },
);

const emit = defineEmits<{
  close: [];
}>();

const instanceId = useId();
const dialogElement = ref<HTMLDialogElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const returnFocusTarget = shallowRef<FocusTarget | null>(null);
const hasScrollLock = ref(false);
const titleId = computed(
  () => props.modalId || `accessible-modal-title-${instanceId}`,
);
const dialogId = computed(() => `${titleId.value}-dialog`);
const displayedTitle = computed(
  () => props.title.trim() || 'Boîte de dialogue',
);
const dialogRole = computed(() => (props.isAlert ? 'alertdialog' : 'dialog'));
const iconIsDsfrClass = computed(
  () => typeof props.icon === 'string' && props.icon.startsWith('fr-icon-'),
);
const iconifyName = computed(() => {
  if (typeof props.icon === 'string') {
    return props.icon;
  }

  return typeof props.icon?.name === 'string' ? props.icon.name : '';
});

function syncBodyModalClass() {
  if (typeof document === 'undefined') {
    return;
  }

  const hasOpenModal = Boolean(
    document.querySelector(
      'dialog[open][aria-modal="true"], .fr-modal--opened:not([data-accessible-modal])',
    ),
  );
  document.body.classList.toggle('modal-open', hasOpenModal);
}

function focusTarget(target: FocusTarget | null) {
  if (!target || typeof target.focus !== 'function') {
    return;
  }

  if (target instanceof HTMLElement && !target.isConnected) {
    return;
  }

  target.focus({ preventScroll: true });
}

function focusInitialElement(dialog: HTMLDialogElement): boolean {
  const requestedTarget = props.initialFocus
    ? dialog.querySelector<HTMLElement>(props.initialFocus)
    : null;

  focusTarget(requestedTarget || closeButton.value);
  if (!dialog.contains(document.activeElement) && requestedTarget) {
    focusTarget(closeButton.value);
  }

  return dialog.contains(document.activeElement);
}

async function focusDialogWhenReady(dialog: HTMLDialogElement) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });

    if (!props.opened || !dialog.open || focusInitialElement(dialog)) {
      return;
    }
  }
}

async function openDialog() {
  await nextTick();

  const dialog = dialogElement.value;
  if (!props.opened || !dialog || dialog.open) {
    return;
  }

  const activeElement = document.activeElement;
  returnFocusTarget.value = props.origin
    || (activeElement instanceof HTMLElement && activeElement !== document.body
      ? activeElement
      : null);

  dialog.showModal();
  lockModalPageScroll();
  hasScrollLock.value = true;
  syncBodyModalClass();
  await focusDialogWhenReady(dialog);
}

async function closeDialog() {
  const dialog = dialogElement.value;
  const target = returnFocusTarget.value;

  if (dialog?.open) {
    dialog.close();
  }
  if (hasScrollLock.value) {
    unlockModalPageScroll();
    hasScrollLock.value = false;
  }
  syncBodyModalClass();
  returnFocusTarget.value = null;

  await nextTick();
  if (document.querySelector('dialog[data-accessible-modal][open]')) {
    return;
  }
  focusTarget(target);
}

function requestClose(event?: Event) {
  event?.preventDefault();
  event?.stopPropagation();
  emit('close');
}

function handleDialogKeydown(event: KeyboardEvent) {
  const dialog = dialogElement.value;
  if (!props.opened || !dialog?.open) {
    return;
  }

  if (event.key === 'Escape') {
    requestClose(event);
    return;
  }

  trapTabKey(event, dialog);
}

watch(
  () => props.opened,
  (opened) => {
    if (opened) {
      void openDialog();
    } else {
      void closeDialog();
    }
  },
  { flush: 'post' },
);

watch(
  () => props.title,
  async () => {
    await nextTick();

    const dialog = dialogElement.value;
    if (
      props.opened
      && dialog?.open
      && !dialog.contains(document.activeElement)
    ) {
      await focusDialogWhenReady(dialog);
    }
  },
  { flush: 'post' },
);

onMounted(() => {
  if (props.opened) {
    void openDialog();
  }
});

onBeforeUnmount(() => {
  if (dialogElement.value?.open) {
    dialogElement.value.close();
  }
  if (hasScrollLock.value) {
    unlockModalPageScroll();
    hasScrollLock.value = false;
  }
  syncBodyModalClass();
});
</script>

<template>
  <dialog
    :id="dialogId"
    ref="dialogElement"
    data-accessible-modal
    :aria-labelledby="titleId"
    aria-modal="true"
    :role="dialogRole"
    class="fr-modal"
    :class="{ 'fr-modal--opened': opened }"
    @cancel="requestClose"
    @keydown="handleDialogKeydown"
  >
    <div class="fr-container fr-container--fluid fr-container-md">
      <div class="fr-grid-row fr-grid-row--center">
        <div
          class="fr-col-12"
          :class="{
            'fr-col-md-8': size === 'lg',
            'fr-col-md-6': size === 'md',
            'fr-col-md-4': size === 'sm',
          }"
        >
          <div class="fr-modal__body">
            <div class="fr-modal__header">
              <button
                ref="closeButton"
                class="fr-btn fr-btn--close"
                :title="closeButtonTitle"
                :aria-controls="dialogId"
                type="button"
                @click="requestClose"
              >
                <span>{{ closeButtonLabel }}</span>
              </button>
            </div>
            <div class="fr-modal__content">
              <h1 :id="titleId" class="fr-modal__title">
                <span
                  v-if="icon && iconIsDsfrClass"
                  :class="String(icon)"
                  aria-hidden="true"
                />
                <Icon
                  v-else-if="iconifyName"
                  :icon="iconifyName"
                  aria-hidden="true"
                />
                {{ displayedTitle }}
              </h1>
              <slot />
            </div>
            <div v-if="actions.length || $slots.footer" class="fr-modal__footer">
              <slot name="footer" />
              <DsfrButtonGroup
                v-if="actions.length"
                align="right"
                :buttons="actions"
                inline-layout-when="large"
                reverse
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  </dialog>
</template>
