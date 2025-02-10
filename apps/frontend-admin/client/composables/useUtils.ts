import type { ArreteCadre } from '~/dto/arrete_cadre.dto';
import type { ArreteRestriction } from "~/dto/arrete_restriction.dto";
import { isValidPhoneNumber } from 'libphonenumber-js';

export const useUtils = () => {
  return {
    debounce(fn: Function, delay: number) {
      let timeoutID: any = null;
      return function () {
        clearTimeout(timeoutID);
        // eslint-disable-next-line prefer-rest-params
        const args = arguments;
        // @ts-ignore
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const that = this;
        timeoutID = setTimeout(function () {
          fn.apply(that, args);
        }, delay);
      };
    },

    isWebglSupported() {
      if (window.WebGLRenderingContext) {
        const canvas = document.createElement('canvas');
        try {
          // Note that { failIfMajorPerformanceCaveat: true } can be passed as a second argument
          // to canvas.getContext(), causing the check to fail if hardware rendering is not available. See
          // https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/getContext
          // for more details.
          const context = canvas.getContext('webgl2') || canvas.getContext('webgl');
          if (context && typeof context.getParameter == 'function') {
            return true;
          }
        } catch (e) {
          // WebGL is supported, but disabled
        }
        return false;
      }
      // WebGL not supported
      return false;
    },

    showInputError(v$: any, inputName: string): string {
      if (v$[inputName]?.$errors.length > 0) {
        return v$[inputName]?.$errors.map((e: any) => e.$message).join('.&nbsp;');
      }
      return '';
    },

    mergeArrays(a: any, b: any, predicate = (a: any, b: any) => a === b) {
      const c = [...a]; // copy to avoid side effects
      // add all items from B to copy C if they're not already present
      b.forEach((bItem: any) => (c.some((cItem) => predicate(bItem, cItem)) ? null : c.push(bItem)));
      return c;
    },

    fileSizeString(size: number) {
      const i = Math.floor(Math.log(size) / Math.log(1024));
      return `${(size / Math.pow(1024, i)).toFixed(2)} ${['o', 'Ko', 'Mo', 'Go', 'To'][i]}`;
    },

    askEditArreteCadre(
      arreteCadre: ArreteCadre,
      modalTitle: Ref<string>,
      modalDescription: Ref<string>,
      modalActions: Ref<any>,
      modalOpened: Ref<boolean>,
      callBackFunction: any,
    ) {
      modalActions.value = [
        {
          label: 'Confirmer',
          'data-cy': 'ConfirmEditFormBtn',
          onclick: () => {
            callBackFunction(arreteCadre.id);
          },
        },
        {
          label: 'Annuler',
          secondary: true,
          onclick: () => {
            this.closeModal(modalOpened);
          },
        },
      ];
      if (arreteCadre.statut === 'a_valider' && arreteCadre.arretesRestriction.length > 0) {
        modalTitle.value = `Modification d’un arrêté cadre avec au moins un arrêté de restriction associé`;
        modalDescription.value = `Vous confirmez prendre en compte que les modifications faites à cet arrêté vont être reportées sur le ou les arrêtés de restriction associés.`;
        modalOpened.value = true;
      } else if (arreteCadre.statut === 'a_valider' && arreteCadre.arretesRestriction.length < 1) {
        callBackFunction(arreteCadre.id);
      } else if (arreteCadre.arretesRestriction.length < 1) {
        modalTitle.value = `Modification d’un arrêté cadre ${arreteCadre.statut === 'a_venir' ? 'à venir' : 'en vigueur'}`;
        modalDescription.value = `Vous confirmez que les modifications concernent uniquement une erreur de saisie et que cette modification ne nécessite pas la création d’un nouvel arrêté cadre.`;
        modalOpened.value = true;
      } else {
        modalTitle.value = `Modification d’un arrêté cadre en vigueur avec au moins un arrêté de restriction associé`;
        modalDescription.value = `Vous confirmez que les modifications concernent uniquement une erreur de saisie et que cette modification ne nécessite pas la création d’un nouvel arrêté cadre.<br/><br/>
Vous confirmez prendre en compte que les modifications faites à cet arrêté vont être reportées sur le ou les arrêtés de restriction associés.`;
        modalOpened.value = true;
      }
    },

    askEditArreteRestriction(
      arreteRestriction: ArreteRestriction,
      modalTitle: Ref<string>,
      modalDescription: Ref<string>,
      modalActions: Ref<any>,
      modalOpened: Ref<boolean>,
      callBackFunction: any,
      ) {
      modalActions.value = [
        {
          label: "Confirmer",
          "data-cy": "ConfirmEditFormBtn",
          onclick: () => {
            callBackFunction(arreteRestriction.id);
          }
        },
        {
          label: "Annuler",
          secondary: true,
          onclick: () => {
            this.closeModal(modalOpened);
          }
        }
      ];
      if (arreteRestriction.statut === "a_valider") {
        callBackFunction(arreteRestriction.id);
      } else {
        modalTitle.value = `Modification d’un arrêté de restriction en vigueur`;
        modalDescription.value = `Vous confirmez que les modifications concernent uniquement une erreur de saisie et que cette modification ne nécessite pas la création d’un nouvel arrêté de restriction.`;
        modalOpened.value = true;
      }
    },

    hasCommonElements(arrays: any[]): boolean {
      for (let i = 0; i < arrays.length - 1; i++) {
        for (let j = i + 1; j < arrays.length; j++) {
          // Si un élément commun est trouvé entre les deux tableaux actuellement comparés, retourne true.
          if (arrays[i].some((ai) => arrays[j].includes(ai))) {
            return true;
          }
        }
      }
      return false;
    },

    closeModal(modalBoolean: any): boolean {
      document.body.classList.remove('modal-open');
      if(typeof modalBoolean != 'boolean') {
        modalBoolean.value = false;        
      }
      return false;
    },
    
    formatDate(date: string | null): string {
      if(!date) {
        return '';
      }
      const dateObject = new Date(date);
      return dateObject ? dateObject.toLocaleDateString('fr') : '';
    },
    
    scrollToTop() {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    
    phoneValidator(value: string) {
      return isValidPhoneNumber(value, 'FR');
    }
  };
};
