import { IsString, IsOptional } from 'class-validator';

export class VerifyPaymentDto {
  @IsString()
  @IsOptional()
  note?: string;
}

export class RejectPaymentDto {
  @IsString()
  @IsOptional()
  reason?: string;
}
