import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Like, Repository } from 'typeorm';
import { AbonnementMail } from '@shared/entities/abonnement_mail.entity';

@Injectable()
export class AbonnementMailService {

  constructor(
    @InjectRepository(AbonnementMail)
    private readonly abonnementMailRepository: Repository<AbonnementMail>,
  ) {
  }

  getCountByDepartement(depCode: string) {
    return this.abonnementMailRepository.count({
      where: {
        commune: Like(`${depCode}${depCode.length === 2 ? '___' : '__'}`),
      },
    });
  }
}