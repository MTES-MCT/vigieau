import { Strategy } from 'passport-custom';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { UserService } from '../user/user.service';

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy, 'local') {
  constructor(private userService: UserService) {
    super();
  }

  async validate(req): Promise<any> {
    const user = await this.userService.findOne(req.params.email);
    if (!user) {
      throw new UnauthorizedException();
    }
    return user;
  }
}
