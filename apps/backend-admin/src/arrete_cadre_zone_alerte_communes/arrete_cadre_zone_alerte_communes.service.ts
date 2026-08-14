import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { ArreteCadreZoneAlerteCommunes } from '@shared/entities/arrete_cadre_zone_alerte_communes.entity';
import { CreateUpdateArreteCadreDto } from '../arrete_cadre/dto/create_update_arrete_cadre.dto';
import { FindOptionsWhere } from 'typeorm/find-options/FindOptionsWhere';

@Injectable()
export class ArreteCadreZoneAlerteCommunesService {
  constructor(
    @InjectRepository(ArreteCadreZoneAlerteCommunes)
    private readonly arreteCadreZoneAlerteCommunesRepository: Repository<ArreteCadreZoneAlerteCommunes>,
  ) {}

  async updateAllByArreteCadre(
    acId: number,
    arreteCadre: CreateUpdateArreteCadreDto,
    manager?: EntityManager,
  ) {
    const repository = manager
      ? manager.getRepository(ArreteCadreZoneAlerteCommunes)
      : this.arreteCadreZoneAlerteCommunesRepository;
    const zonesWithCommunesById = new Map(
      arreteCadre.zonesAlerte
        .filter((zone) => zone.communes && zone.communes.length > 0)
        .map((zone) => [zone.id, zone]),
    );
    const existingAssociations = await repository.find({
      relations: {
        zoneAlerte: true,
      },
      where: {
        arreteCadre: {
          id: acId,
        },
      },
    });
    const existingAssociationsByZoneId = new Map(
      existingAssociations.map((association) => [
        association.zoneAlerte.id,
        association,
      ]),
    );

    // SUPPRESSION DES ANCIENNES ZONES / COMMUNES
    const associationIdsToDelete = existingAssociations
      .filter(
        (association) => !zonesWithCommunesById.has(association.zoneAlerte.id),
      )
      .map((association) => association.id);
    if (associationIdsToDelete.length > 0) {
      await repository.delete(<FindOptionsWhere<ArreteCadreZoneAlerteCommunes>>{
        id: In(associationIdsToDelete),
      });
    }

    const arreteCadreZoneAlerteCommunes = Array.from(
      zonesWithCommunesById.values(),
      (zone) => {
        const existingAssociation = existingAssociationsByZoneId.get(zone.id);
        return <ArreteCadreZoneAlerteCommunes>{
          ...(existingAssociation ? { id: existingAssociation.id } : {}),
          arreteCadre: { id: acId },
          zoneAlerte: { id: zone.id },
          communes: zone.communes,
        };
      },
    );

    if (arreteCadreZoneAlerteCommunes.length === 0) {
      return [];
    }
    return repository.save(arreteCadreZoneAlerteCommunes);
  }
}
