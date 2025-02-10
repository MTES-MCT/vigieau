import { HttpException, HttpStatus } from '@nestjs/common';

const NIVEAUX_INT = {
  crise: 5,
  alerte_renforcee: 4,
  alerte: 3,
  vigilance: 2
};

export class Utils {
  /**
   * Vérification de l'extension d'un document entrant pour s'assurer qu'il s'agisse d'un fichier pdf
   * @param req
   * @param file
   * @param callback
   */
  static pdfFileFilter = (req, file, callback) => {
    if (!file.originalname.match(/\.(pdf)$/)) {
      return callback(
        new HttpException(
          'Seul les fichiers en .pdf sont acceptés.',
          HttpStatus.BAD_REQUEST,
        ),
        false,
      );
    }
    return callback(null, true);
  };

  static getNiveau(niveauAlerte) {
    return niveauAlerte in NIVEAUX_INT ? NIVEAUX_INT[niveauAlerte] : 1
  }

  static getNiveauInversed(niveauAlerte) {
    return Object.keys(NIVEAUX_INT).find(key => NIVEAUX_INT[key] === niveauAlerte)
  }
}
