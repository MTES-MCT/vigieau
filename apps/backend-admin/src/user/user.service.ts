import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { DeleteResult, In, Like, Repository } from 'typeorm';
import { Departement } from '../departement/entities/departement.entity';
import moment from 'moment';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  findAll(currentUser?: User): Promise<User[]> {
    const where =
      !currentUser || currentUser.role === 'mte'
        ? {}
        : {
            role: currentUser.role,
            role_departement: In(currentUser.role_departements),
          };
    return this.userRepository.find({ where, order: { email: 'ASC' }});
  }

  findOne(email: string): Promise<User> {
    if (!email) {
      return null;
    }
    const emailToSearch = email.toLowerCase().trim();
    return this.userRepository.findOne({ where: { email: emailToSearch } });
  }

  checkRules(email: string): Promise<any> {
    if (!email) {
      return null;
    }
    const emailToSearch = email.toLowerCase().trim();
    return this.userRepository.update(
      { email: emailToSearch },
      { check_rules: moment().format('YYYY-MM-DD') },
    );
  }

  updateName(email: string, firstName: string, lastName: string) {
    return this.userRepository.update(
      { email },
      { first_name: firstName, last_name: lastName, last_login: (new Date()).toISOString() },
    );
  }

  findByDepartementsId(depIds: number[]): Promise<User[]> {
    return this.userRepository
      .createQueryBuilder('user')
      .leftJoinAndSelect(
        Departement,
        'departement',
        'departement.code IN(SELECT unnest(user.role_departements))',
      )
      .where('departement.id IN (:...depIds)', { depIds })
      .getMany();
  }

  findByDepartementsCode(depCodes: string[]): Promise<User[]> {
    return this.userRepository
      .createQueryBuilder('user')
      .leftJoinAndSelect(
        Departement,
        'departement',
        `departement.code = ANY(user.role_departements)`,
      )
      .where('departement.code IN (:...depCodes)', { depCodes })
      .getMany();
  }

  async create(currentUser: User, user: User): Promise<User> {
    if (
      currentUser.role === 'departement' &&
      (user.role !== 'departement' ||
        user.role_departements.some(d => !currentUser.role_departements.includes(d)))
    ) {
      throw new HttpException(
        "Vous ne pouvez créer un utilisateur qu'avec un droit sur votre département.",
        HttpStatus.FORBIDDEN,
      );
    }
    user.email = user.email.toLowerCase();
    const userExists = await this.findOne(user.email);
    if (!userExists) {
      return this.userRepository.save(this._formatUser(user));
    }
    throw new HttpException(
      'Un utilisateur avec cet email existe déjà.',
      HttpStatus.FORBIDDEN,
    );
  }

  async update(email: string, user: User) {
    await this.userRepository.update({ email }, this._formatUser(user));
    return this.findOne(email);
  }

  async remove(currentUser: User, email: string) {
    if (currentUser.role === 'departement') {
      const userToDelete = await this.findOne(email);
      if (!userToDelete) {
        throw new HttpException(
          "Cet utilisateur n'existe pas",
          HttpStatus.BAD_REQUEST,
        );
      }
      if (
        userToDelete.role !== currentUser.role ||
        userToDelete.role_departements.some(d => !currentUser.role_departements.includes(d))
      ) {
        throw new HttpException(
          'Vous ne pouvez supprimer des utilisateurs que sur vos départements.',
          HttpStatus.FORBIDDEN,
        );
      }
    }
    return this.userRepository.delete({ email });
  }

  private _formatUser(user: User) {
    if (user.role === 'mte') {
      user.role_departements = null;
    }
    return user;
  }

  /**
   * Suppression des données générées par les tests E2E
   * Par convention les données générées par les tests E2E sont préfixées par CYTEST
   */
  removeTestData(): Promise<DeleteResult> {
    return this.userRepository.delete({ email: Like('CYTEST%') });
  }
}
