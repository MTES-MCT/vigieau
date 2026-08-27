import { EntityManager, In, Repository } from 'typeorm';
import { ParametresService } from './parametres.service';
import { Parametres } from '@shared/entities/parametres.entity';
import { DepartementService } from '../departement/departement.service';
import { User } from '@shared/entities/user.entity';
import { recordPublicMutation } from '../zone_publication/public-mutation';

jest.mock('../zone_publication/public-mutation', () => ({
  recordPublicMutation: jest.fn(),
}));

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

  describe('createUpdate', () => {
    const user = { role: 'mte' } as User;
    const departement = { id: 77, code: '77' };

    function createHarness(existingParam: Parametres | null) {
      const transactionalRepository = {
        findOne: jest.fn().mockResolvedValue(existingParam),
        delete: jest.fn().mockResolvedValue(undefined),
        save: jest.fn(async (value) => value),
      };
      const manager = {
        getRepository: jest.fn().mockReturnValue(transactionalRepository),
      } as unknown as EntityManager;
      const repository = {
        manager: {
          transaction: jest.fn(async (callback) => callback(manager)),
        },
      } as unknown as Repository<Parametres>;
      const departementService = {
        findByCode: jest.fn().mockResolvedValue(departement),
      } as unknown as DepartementService;
      return {
        service: new ParametresService(repository, departementService),
        manager,
        transactionalRepository,
      };
    }

    beforeEach(() => {
      jest.mocked(recordPublicMutation).mockReset().mockResolvedValue('42');
    });

    it('records the department mutation in the same transaction', async () => {
      const existing = {
        id: 1,
        dateDebut: '2026-08-01',
        superpositionCommune: 'no',
      } as Parametres;
      const next = { superpositionCommune: 'yes_all' } as Parametres;
      const harness = createHarness(existing);

      await harness.service.createUpdate(user, '77', next);

      expect(harness.transactionalRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ disabled: true }),
      );
      expect(recordPublicMutation).toHaveBeenCalledWith(
        harness.manager,
        [77],
        'PARAMETRES DE CALCUL',
      );
    });

    it('does not invalidate the source when the active rule is unchanged', async () => {
      const existing = {
        id: 1,
        superpositionCommune: 'yes_all',
      } as Parametres;
      const harness = createHarness(existing);

      await expect(
        harness.service.createUpdate(user, '77', {
          superpositionCommune: 'yes_all',
        } as Parametres),
      ).resolves.toBe(existing);

      expect(recordPublicMutation).not.toHaveBeenCalled();
      expect(harness.transactionalRepository.save).not.toHaveBeenCalled();
    });
  });
});
