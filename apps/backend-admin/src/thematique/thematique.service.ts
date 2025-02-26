import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Thematique } from '@shared/entities/thematique.entity';

@Injectable()
export class ThematiqueService {
  constructor(
    @InjectRepository(Thematique)
    private readonly thematiqueRepository: Repository<Thematique>,
  ) {}

  findAll(): Promise<Thematique[]> {
    return this.thematiqueRepository.find({
      order: {
        nom: 'ASC',
      },
    });
  }
}
