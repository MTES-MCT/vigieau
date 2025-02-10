import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { User } from '../user/entities/user.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { FindManyOptions, FindOneOptions, FindOptionsWhere, In, Repository } from 'typeorm';
import { Parametres } from './entities/parametres.entity';
import { DepartementService } from '../departement/departement.service';
import moment from 'moment/moment';

@Injectable()
export class ParametresService {
  constructor(
    @InjectRepository(Parametres)
    private readonly parametresRepository: Repository<Parametres>,
    private readonly departementService: DepartementService,
  ) {
  }

  async findAll(currentUser?: User, enabled?: boolean): Promise<Parametres[]> {
    const whereClause: FindOptionsWhere<Parametres> | null =
      !currentUser || currentUser.role === 'mte'
        ? {
          disabled: enabled ? false : null,
        }
        : {
          departement: {
            code: In(currentUser.role_departements),
          },
          disabled: enabled ? false : null,
        };
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
        'Vous n\'avez pas les droits pour modifier ces paramètres',
        HttpStatus.FORBIDDEN,
      );
    }
    const dep = await this.departementService.findByCode(depCode);
    const existingParam = await this.parametresRepository.findOne(<FindOneOptions>{
      where: {
        disabled: false,
        departement: {
          id: dep.id,
        },
      },
    });
    // Si c'est la même règle que le paramètre en cours, on ne fait rien
    if (existingParam && existingParam.superpositionCommune === parametresToCreate.superpositionCommune) {
      return existingParam;
    }
    if (existingParam) {
      existingParam.dateFin = moment().format('YYYY-MM-DD');
      // Si le paramètre a été actif moins d'un jour, on le supprime.
      if (existingParam.dateDebut === existingParam.dateFin) {
        await this.parametresRepository.delete({ id: existingParam.id });
      } else {
        await this.parametresRepository.save(existingParam);
      }
    }
    parametresToCreate.departement = dep;
    parametresToCreate.dateDebut = moment().format('YYYY-MM-DD');
    return this.parametresRepository.save(parametresToCreate);
  }
}
