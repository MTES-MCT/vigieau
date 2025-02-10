import { UserApi } from '~/api/user';
import { ZoneAlerteApi } from '~/api/zone-alerte';
import { BaseApi } from '~/api/base-api';
import { ArreteCadreApi } from "~/api/arrete-cadre";
import { ArreteRestrictionApi } from "~/api/arrete-restriction";
import { ArreteMunicipalApi } from "~/api/arrete-municipal";
import { ParametresApi } from "~/api/parametres";
import { CommuneApi } from "~/api/commune";
import { BaseApiPagination } from '~/api/base-api-pagination';

export const useApi = () => {
  return {
    arreteCadre: new ArreteCadreApi('arrete-cadre'),
    arreteRestriction: new ArreteRestrictionApi('arrete-restriction'),
    arreteMunicipal: new ArreteMunicipalApi('arrete-municipal'),
    zoneAlerte: new ZoneAlerteApi('zone-alerte'),
    user: new UserApi('user'),
    departement: new UserApi('departement'),
    usage: new BaseApi('usage'),
    thematique: new BaseApi('thematique'),
    commune: new CommuneApi('commune'),
    parametres: new ParametresApi('parametres'),
    statisticDepartement: new BaseApi('statistic_departement'),
    usageFeedback: new BaseApiPagination('usage_feedback'),
  };
};
