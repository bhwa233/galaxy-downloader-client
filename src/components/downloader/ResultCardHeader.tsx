import { Share2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { CardHeader, CardTitle } from '@/components/ui/card';
import { useDictionary } from '@/i18n/client';
import { formatDuration } from '@/lib/utils';

interface ResultCardHeaderProps {
    title: string;
    duration?: number | null;
    canSharePlayLink: boolean;
    onCopyShareLink: () => void;
    onClose: () => void;
}

export function ResultCardHeader({
    title,
    duration,
    canSharePlayLink,
    onCopyShareLink,
    onClose,
}: ResultCardHeaderProps) {
    const dict = useDictionary();

    return (
        <CardHeader className="p-3 pb-2">
            <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-base">{dict.result.title}</CardTitle>
                <div className="flex items-center gap-1.5">
                    {canSharePlayLink && (
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-8 gap-1.5 text-xs"
                            onClick={onCopyShareLink}
                            title={dict.result.sharePlayLink}
                        >
                            <Share2 className="h-4 w-4" />
                            <span>{dict.result.sharePlayLink}</span>
                        </Button>
                    )}
                    <Button variant="ghost" size="sm" className="h-8 w-8 px-0" onClick={onClose}>
                        <X className="h-4 w-4" />
                    </Button>
                </div>
            </div>
            <p
                className="line-clamp-2 text-[13px] leading-snug text-foreground/80 break-words"
                title={title}
            >
                {title}
                {duration != null && (
                    <span className="ml-2 text-xs text-foreground/70">({formatDuration(duration)})</span>
                )}
            </p>
        </CardHeader>
    );
}
