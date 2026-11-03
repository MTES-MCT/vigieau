import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';
import {
  ApiExcludeController,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { CreateSubscriptionDto } from './dto/create_subscription.dto';
import { SubscriptionDto } from './dto/subscription.dto';
import JwtGuard from '../auth/jwt.guard';
import { Throttle } from '@nestjs/throttler';
import { RequestManagementLinkDto } from './dto/request_management_link.dto';
import { subscriptionRateLimitTracker } from './subscription-rate-limit';

@Controller('subscriptions')
@ApiExcludeController()
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  @Post()
  @Throttle({
    default: {
      limit: 10,
      ttl: 15 * 60_000,
      getTracker: subscriptionRateLimitTracker,
    },
  })
  @ApiOperation({ summary: 'Abonnement email à une adresse' })
  @ApiResponse({
    status: 201,
    type: SubscriptionDto,
  })
  async create(
    @Req() req,
    @Body() createSubscriptionsDto: CreateSubscriptionDto,
  ): Promise<SubscriptionDto> {
    const ips = req.headers['x-forwarded-for'] as string;
    const userIp = typeof ips === 'string' ? ips.split(',')[0].trim() : req.ip;

    return this.subscriptionsService.create(createSubscriptionsDto, userIp);
  }

  @Post('management-link')
  @HttpCode(202)
  @Throttle({
    default: {
      limit: 3,
      ttl: 15 * 60_000,
      getTracker: subscriptionRateLimitTracker,
    },
  })
  requestManagementLink(@Body() body: RequestManagementLinkDto) {
    return this.subscriptionsService.requestManagementLink(body.email);
  }

  @UseGuards(JwtGuard)
  @Get('')
  @ApiOperation({ summary: "Retourne les abonnements d'un utilisateur" })
  getAll(@Req() req) {
    return this.subscriptionsService.getSubscriptionsByEmail(req.user.email);
  }

  @UseGuards(JwtGuard)
  @Delete(['', 'all'])
  @HttpCode(204)
  @ApiOperation({
    summary: "Suppression de tous les abonnements d'un utilisateur",
  })
  removeAll(@Req() req) {
    return this.subscriptionsService.deleteSubscriptionByEmail(req.user.email);
  }

  @UseGuards(JwtGuard)
  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: "Suppression d'un abonnement" })
  remove(@Req() req, @Param('id', ParseIntPipe) id: number | string) {
    return this.subscriptionsService.deleteSubscriptionById(
      Number(id),
      req.user.email,
    );
  }
}
