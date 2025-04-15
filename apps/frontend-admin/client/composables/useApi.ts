import { ArreteCadreApi } from '~/api/arrete-cadre';
import { ArreteMunicipalApi } from '~/api/arrete-municipal';
import { ArreteRestrictionApi } from '~/api/arrete-restriction';
import { BaseApi } from '~/api/base-api';
import { BaseApiPagination } from '~/api/base-api-pagination';
import { CommuneApi } from '~/api/commune';
import { ParametresApi } from '~/api/parametres';
import { UserApi } from '~/api/user';
import { VigiEauApi } from '~/api/vigieau';
import { ZoneAlerteApi } from '~/api/zone-alerte';

export const useApi = () => {
  return {
    arreteCadre: new ArreteCadreApi('arrete-cadre'),
    arreteRestriction: new ArreteRestrictionApi('arrete-restriction'),
    arreteMunicipal: new ArreteMunicipalApi('arrete-municipal'),
    zoneAlerte: new ZoneAlerteApi('zone-alerte'),
    user: new UserApi('user'),
    departement: new BaseApi('departement'),
    usage: new BaseApi('usage'),
    thematique: new BaseApi('thematique'),
    commune: new CommuneApi('commune'),
    parametres: new ParametresApi('parametres'),
    statisticDepartement: new BaseApi('statistic_departement'),
    usageFeedback: new BaseApiPagination('usage_feedback'),
    vigiEau: new VigiEauApi(),
  };
};
