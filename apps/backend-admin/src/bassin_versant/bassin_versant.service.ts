import { Injectable } from '@nestjs/common';
import { BassinVersant } from '@shared/entities/bassin_versant.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

@Injectable()
export class BassinVersantService {

  constructor(
    @InjectRepository(BassinVersant)
    private readonly bassinVersantRepository: Repository<BassinVersant>,
  ) {
  }

  findByCode(bassinVersantCode: number): Promise<BassinVersant> {
    return this.bassinVersantRepository.findOne({
      select: ['id', 'code'],
      where: {
        code: bassinVersantCode,
      },
    });
  }
}