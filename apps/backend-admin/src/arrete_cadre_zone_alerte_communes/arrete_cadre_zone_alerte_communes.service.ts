import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { ArreteCadreZoneAlerteCommunes } from '@shared/entities/arrete_cadre_zone_alerte_communes.entity';
import { CreateUpdateArreteCadreDto } from '../arrete_cadre/dto/create_update_arrete_cadre.dto';
import { FindOptionsWhere } from 'typeorm/find-options/FindOptionsWhere';

@Injectable()
export class ArreteCadreZoneAlerteCommunesService {
  constructor(@InjectRepository(ArreteCadreZoneAlerteCommunes)
              private readonly arreteCadreZoneAlerteCommunesRepository: Repository<ArreteCadreZoneAlerteCommunes>) {
  }

  async updateAllByArreteCadre(acId: number, arreteCadre: CreateUpdateArreteCadreDto) {
    const zonesWithCommunes = arreteCadre.zonesAlerte.filter(z => z.communes && z.communes.length > 0);

    // SUPPRESSION DES ANCIENNES ZONES / COMMUNES
    await this.arreteCadreZoneAlerteCommunesRepository.delete(<FindOptionsWhere<ArreteCadreZoneAlerteCommunes>>{
      arreteCadre: {
        id: acId,
      },
      id: Not(In(zonesWithCommunes.map(z => z.id))),
    });

    const arreteCadreZoneAlerteCommunes: ArreteCadreZoneAlerteCommunes[] = [];
    zonesWithCommunes.forEach(z => {
      arreteCadreZoneAlerteCommunes.push(<ArreteCadreZoneAlerteCommunes> {
        arreteCadre: { id: acId },
        zoneAlerte: { id: z.id },
        communes: z.communes
      });
    });

    return this.arreteCadreZoneAlerteCommunesRepository.save(arreteCadreZoneAlerteCommunes);
  }
}