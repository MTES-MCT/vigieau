import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { UsageFeedback, usageFeedbackPaginateConfig } from '@shared/entities/usage_feedback.entity';
import { User } from '@shared/entities/user.entity';
import { paginate, Paginated, PaginateQuery } from 'nestjs-paginate';
import { ArreteCadre } from '@shared/entities/arrete_cadre.entity';
import { arreteCadrePaginateConfig } from '../arrete_cadre/dto/arrete_cadre.dto';

@Injectable()
export class UsageFeedbackService {
  constructor(@InjectRepository(UsageFeedback)
              private readonly usageFeedbackRepository: Repository<UsageFeedback>) {
  }

  findAll(currentUser: any): any {
    const whereClause = {
      archived: false,
    };
    if (currentUser && currentUser.role !== 'mte') {
      whereClause['arreteRestriction'] = {
        departement: {
          code: In(currentUser.role_departements),
        },
      };
    }

    return this.usageFeedbackRepository.find({
      select: {
        id: true,
        usageNom: true,
        usageThematique: true,
        usageDescription: true,
        createdAt: true,
        feedback: true,
        arreteRestriction: {
          id: true,
          departement: {
            code: true,
          },
        },
      },
      relations: ['arreteRestriction', 'arreteRestriction.departement'],
      where: whereClause,
    });
  }

  async paginate(currentUser: any, query: PaginateQuery): Promise<Paginated<UsageFeedback>> {
    const paginateConfig = usageFeedbackPaginateConfig;
    if (currentUser && currentUser.role !== 'mte') {
      paginateConfig.where['arreteRestriction'] = {
        departement: {
          code: In(currentUser.role_departements),
        },
      };
    }
    const paginateToReturn = await paginate(
      query,
      this.usageFeedbackRepository,
      paginateConfig,
    );

    return paginateToReturn;
  }

  async remove(currentUser: User, id: string) {
    if (currentUser.role === 'departement') {
      const whereClause = {
        archived: false,
        arreteRestriction: {
          departement: {
            code: In(currentUser.role_departements),
          },
        },
      };
      const feedback = await this.usageFeedbackRepository.find({ where: whereClause });
      if(!feedback) {
        throw new HttpException(
          'Vous ne pouvez supprimer des feedbacks que sur vos départements.',
          HttpStatus.FORBIDDEN,
        );
      }
    }
    return this.usageFeedbackRepository.update(+id, { archived: true });
  }
}
