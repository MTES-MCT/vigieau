import { In, Repository } from 'typeorm';
import { ParametresService } from './parametres.service';
import { Parametres } from '@shared/entities/parametres.entity';
import { DepartementService } from '../departement/departement.service';
import { User } from '@shared/entities/user.entity';

describe('ParametresService', () => {
  let service: ParametresService;
  let parametresRepository: jest.Mocked<Pick<Repository<Parametres>, 'find'>>;

  beforeEach(() => {
    parametresRepository = {
      find: jest.fn(),
    };

    service = new ParametresService(
      parametresRepository as unknown as Repository<Parametres>,
      {} as DepartementService,
    );
  });

  describe('findAll', () => {
    it('should only return active parameters for MTE users', async () => {
      await service.findAll({ role: 'mte' } as User);

      expect(parametresRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            disabled: false,
          },
        }),
      );
    });

    it('should only return active parameters for the user departments', async () => {
      await service.findAll({
        role: 'departement',
        role_departements: ['40', '88'],
      } as User);

      expect(parametresRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            disabled: false,
            departement: {
              code: In(['40', '88']),
            },
          },
        }),
      );
    });
  });
});
