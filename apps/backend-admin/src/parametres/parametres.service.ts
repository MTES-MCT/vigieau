import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Parametres } from '@shared/entities/parametres.entity';
import { User } from '@shared/entities/user.entity';
import {
  FindManyOptions,
  FindOneOptions,
  FindOptionsWhere,
  In,
  Repository,
} from 'typeorm';
import { DepartementService } from '../departement/departement.service';
import { getCurrentParisCivilDate } from '../shared/arrete-date-continuity';
import { recordPublicMutation } from '../zone_publication/public-mutation';

@Injectable()
export class ParametresService {
  constructor(
    @InjectRepository(Parametres)
    private readonly parametresRepository: Repository<Parametres>,
    private readonly departementService: DepartementService,
  ) {}

  async findAll(currentUser?: User): Promise<Parametres[]> {
    const whereClause: FindOptionsWhere<Parametres> = {
      disabled: false,
    };

    if (currentUser && currentUser.role !== 'mte') {
      whereClause.departement = {
        code: In(currentUser.role_departements),
      };
    }

    return this.parametresRepository.find(<FindManyOptions>{
      select: {
        id: true,
        superpositionCommune: true,
        departement: {
          id: true,
          code: true,
        },
      },
      relations: ['departement'],
      where: whereClause,
      order: {
        departement: {
          code: 'ASC',
        },
      },
    });
  }

  async findOne(depCode: string): Promise<Parametres> {
    return this.parametresRepository.findOne(<FindOneOptions>{
      select: {
        id: true,
        superpositionCommune: true,
        departement: {
          id: true,
          code: true,
        },
      },
      relations: ['departement'],
      where: {
        disabled: false,
        departement: {
          code: depCode,
        },
      },
    });
  }

  async createUpdate(
    currentUser: User,
    depCode: string,
    parametresToCreate: Parametres,
  ): Promise<Parametres> {
    if (
      currentUser &&
      currentUser.role !== 'mte' &&
      !currentUser.role_departements.includes(depCode)
    ) {
      throw new HttpException(
        "Vous n'avez pas les droits pour modifier ces paramètres",
        HttpStatus.FORBIDDEN,
      );
    }
    const dep = await this.departementService.findByCode(depCode);
    return this.parametresRepository.manager.transaction(async (manager) => {
      const businessDate = getCurrentParisCivilDate();
      const repository = manager.getRepository(Parametres);
      const existingParam = await repository.findOne(<FindOneOptions>{
        where: {
          disabled: false,
          departement: {
            id: dep.id,
          },
        },
      });
      // Si c'est la même règle que le paramètre en cours, on ne fait rien
      if (
        existingParam &&
        existingParam.superpositionCommune ===
          parametresToCreate.superpositionCommune
      ) {
        return existingParam;
      }
      if (existingParam) {
        existingParam.dateFin = businessDate;
        existingParam.disabled = true;
        // Si le paramètre a été actif moins d'un jour, on le supprime.
        if (existingParam.dateDebut === existingParam.dateFin) {
          await repository.delete({ id: existingParam.id });
        } else {
          await repository.save(existingParam);
        }
      }
      parametresToCreate.departement = dep;
      parametresToCreate.dateDebut = businessDate;
      const saved = await repository.save(parametresToCreate);
      await recordPublicMutation(manager, [dep.id], 'PARAMETRES DE CALCUL');
      return saved;
    });
  }
}
