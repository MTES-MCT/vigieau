import { User } from '@shared/entities/user.entity';
import { Fichier } from '@shared/entities/fichier.entity';

export function canAccessDocument(user: User, file: Fichier): boolean {
  if (!user || !file) return false;
  if (user.role === 'mte') return true;
  if (user.role === 'departement') {
    const codes = new Set(user.role_departements ?? []);
    return (
      !!file.arreteCadre?.departements?.some((dep) => codes.has(dep.code)) ||
      codes.has(file.arreteRestriction?.departement?.code) ||
      !!file.arreteMunicipal?.communes?.some((commune) =>
        codes.has(commune.departement?.code),
      )
    );
  }
  if (user.role === 'commune') {
    const codes = new Set(user.role_communes ?? []);
    return !!file.arreteMunicipal?.communes?.some((commune) =>
      codes.has(commune.code),
    );
  }
  return false;
}
