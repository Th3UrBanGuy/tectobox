import { IsString, IsNotEmpty, IsOptional, IsNumber, IsArray, Min } from 'class-validator';

export class IssueLicenseDto {
  @IsNumber()
  @IsNotEmpty()
  client_id!: number;

  @IsString()
  @IsOptional()
  deliver?: string;

  @IsString()
  @IsOptional()
  mode?: string;

  @IsNumber()
  @IsOptional()
  @Min(0.0001)
  days?: number;

  @IsString()
  @IsOptional()
  kind?: string;

  @IsArray()
  @IsOptional()
  features?: string[];

  @IsNumber()
  @IsOptional()
  credits?: number;

  @IsNumber()
  @IsOptional()
  credits_total?: number;

  @IsString()
  @IsOptional()
  billing_period?: string;

  @IsNumber()
  @IsOptional()
  plan_id?: number;

  @IsNumber()
  @IsOptional()
  planId?: number;
}

export class ActivateLicenseDto {
  @IsString()
  @IsNotEmpty()
  code!: string;
}
